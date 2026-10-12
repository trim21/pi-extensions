// internal-init：由 supervisor 以 clone(CLONE_NEWUSER|NEWPID|NEWNS|NEWNET) 启动，
// 是新 namespace 里的 PID 1。职责：拉起 lo、等 slirp4netns 建好 tap0、起 mihomo、
// 等网络接管完成，然后在目标 netns 内执行调用方给的 bwrap 命令行。
//
// 作为 PID 1 退出时，内核会清理整个 pid namespace（mihomo 一并消失），
// 它持有的 exit-fd 写端随之关闭，slirp4netns 收到 HUP 自行退出。
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"sort"
	"strings"
	"syscall"
	"time"
)

func runInit(args []string) int {
	flags := flag.NewFlagSet("internal-init", flag.ContinueOnError)
	policyBase64 := flags.String("policy-base64", "", "")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	policy, err := parsePolicyBase64(*policyBase64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "init: %v\n", err)
		return exitStartup
	}

	// stdin EOF = 调用方结束本次执行（正常停栈或调用方进程死亡）。作为 PID 1 退出
	// 会触发内核清理整个 namespace，所以这里不需要自己清理子进程。
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}()

	// 先把本 mount namespace 的挂载树设为 private：新 ns 复制的是宿主的挂载表，
	// shared 挂载点上的改动会跨 ns 传播回宿主（下一步挂 procfs 就会顶掉宿主的 /proc）。
	if err := syscall.Mount("", "/", "", syscall.MS_REC|syscall.MS_PRIVATE, ""); err != nil {
		fmt.Fprintf(os.Stderr, "init: 设置挂载传播为 private 失败: %v\n", err)
		return exitStartup
	}
	// pid namespace 内必须是新挂载的 procfs：宿主 /proc 里没有本 pid namespace 的进程视角
	// （/proc/self 仍指向宿主的 pid），bwrap 这类靠 /proc/<pid>/ns/* 操作 namespace 的程序
	// 会因此失败——util-linux 的 unshare --mount-proc 做的就是这一步。
	if err := syscall.Mount("proc", "/proc", "proc", 0, ""); err != nil {
		fmt.Fprintf(os.Stderr, "init: 挂载 procfs 到 /proc 失败: %v\n", err)
		return exitStartup
	}

	// 新 netns 里的 lo 默认是 down；起 mihomo 的 TUN 之前先拉起来。
	// 需要 CAP_NET_ADMIN：在 userns 内我们是 root（unshare -Ur 的等价映射）。
	if output, err := exec.Command("ip", "link", "set", "lo", "up").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "init: 拉起 lo 失败（继续）: %v %s\n", err, strings.TrimSpace(string(output)))
	}

	if policy.Network.Mode == NetworkLimited {
		if err := waitForInterface("tap0", 10*time.Second); err != nil {
			fmt.Fprintf(os.Stderr, "init: slirp4netns 未在 10s 内创建 tap0: %v\n", err)
			return exitStartup
		}
		mihomo, mihomoFd, startErr := startMihomo(policy)
		if startErr != nil {
			fmt.Fprintf(os.Stderr, "init: %v\n", startErr)
			return exitStartup
		}
		// 终止只走 pidfd；等待用 exec 自己的 Wait，超时才 SIGKILL。
		// 即便它不响应，init 退出时的内核清理也会兜住。
		defer func() {
			_ = mihomoFd.Send(syscall.SIGTERM)
			done := make(chan struct{})
			go func() {
				_, _ = mihomo.Process.Wait()
				close(done)
			}()
			select {
			case <-done:
			case <-time.After(stopGrace):
				_ = mihomoFd.Send(syscall.SIGKILL)
				<-done
			}
			mihomoFd.Close()
		}()
	}

	// bwrap 参数由执行器构造（策略是能力描述；这份知识只在这里一处）
	argv, err := buildBwrapArgv(policy, policy.Bwrap.Path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "init: %v\n", err)
		return exitStartup
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = envSlice(policy.Env)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if devNull, err := os.Open(os.DevNull); err == nil {
		cmd.Stdin = devNull
		defer devNull.Close()
	}
	return exitCodeOf(cmd.Run(), 1)
}

// startMihomo 起过滤进程，把它的输出接到自己的 stderr（带 netstackPrefix，宿主侧
// 据此把诊断与命令 stderr 分开），等网络接管完成后打印就绪标记。返回 pidfd：
// 终止与超时都经它，代码里不留按 pid 的终止路径。
func startMihomo(policy Policy) (*exec.Cmd, *pidfd, error) {
	configBase64, err := generateMihomoConfig(policy.Network.Allowlist, policy.Network.DNSServers, policy.Mihomo.MTU)
	if err != nil {
		return nil, nil, err
	}
	home, err := os.MkdirTemp("", "sandbox-mihomo-")
	if err != nil {
		return nil, nil, fmt.Errorf("建 mihomo 工作目录失败: %w", err)
	}
	readSide, writeSide, err := os.Pipe()
	if err != nil {
		return nil, nil, fmt.Errorf("建 mihomo 输出管道失败: %w", err)
	}
	cmd := exec.Command(policy.Mihomo.Path, "-d", home, "-config", configBase64)
	cmd.Stdout = writeSide
	cmd.Stderr = writeSide
	if err := cmd.Start(); err != nil {
		writeSide.Close()
		readSide.Close()
		return nil, nil, fmt.Errorf("启动 mihomo 失败: %w", err)
	}
	writeSide.Close()
	// 在任何 Wait 之前打开：此刻 mihomo 尚未被 reap，pidfd 一定指向它
	mihomoFd, err := pidfdOpen(cmd.Process.Pid)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return nil, nil, fmt.Errorf("pidfd_open(mihomo): %w", err)
	}

	ready := make(chan struct{})
	go func() {
		defer readSide.Close()
		scanner := bufio.NewScanner(readSide)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		readyOnce := false
		for scanner.Scan() {
			line := scanner.Text()
			fmt.Fprintln(os.Stderr, netstackPrefix+line)
			if !readyOnce && strings.Contains(line, "Tun adapter listening") {
				readyOnce = true
				close(ready)
			}
		}
	}()

	select {
	case <-ready:
		fmt.Fprintln(os.Stderr, readyMarker)
		return cmd, mihomoFd, nil
	case <-time.After(readyTimeout):
		_ = mihomoFd.Send(syscall.SIGKILL)
		mihomoFd.Close()
		_ = cmd.Wait()
		return nil, nil, fmt.Errorf("mihomo 未在 20s 内完成网络接管")
	}
}

func waitForInterface(name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if iface, err := net.InterfaceByName(name); err == nil && iface != nil {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("接口 %s 未出现", name)
}

// envSlice 把策略里的环境变量摊平成 exec.Cmd 需要的形式（命令不继承 init 的环境）。
func envSlice(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, key+"="+env[key])
	}
	return out
}
