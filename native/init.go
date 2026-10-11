// internal-init：由 supervisor 以 clone(CLONE_NEWUSER|NEWPID|NEWNS|NEWNET) 启动，
// 是新 namespace 里的 PID 1。它负责：让 lo 起来、等 slirp4netns 建好 tap0、
// 起 mihomo、等网络接管完成、在目标 netns 内直接执行 bwrap 命令。
//
// 它作为 PID 1 退出时内核会清理整个 pid namespace（mihomo 一并消失），
// 持有的 exit-fd 写端随之关闭，slirp4netns 收到 HUP 自行退出。
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
	command := flags.String("command", "", "")
	cwd := flags.String("cwd", "", "")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	policy, err := parsePolicyBase64(*policyBase64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "init: %v\n", err)
		return exitStartup
	}
	if *cwd != "" {
		if err := os.Chdir(*cwd); err != nil {
			fmt.Fprintf(os.Stderr, "init: 切换工作目录失败: %v\n", err)
			return exitStartup
		}
	}

	// stdin EOF = 宿主请你退出（正常停栈或宿主进程死亡）。作为 PID 1 退出会触发
	// 内核清理整个 namespace，所以这里不需要自己清理子进程。
	go func() {
		_, _ = io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}()

	// 新 netns 里的 lo 默认是 down；起 mihomo 的 TUN 之前先拉起来。
	// 需要 CAP_NET_ADMIN：在 userns 内我们是 root（unshare -Ur 的等价映射）。
	if output, err := exec.Command("ip", "link", "set", "lo", "up").CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "init: 拉起 lo 失败（继续）: %v %s\n", err, strings.TrimSpace(string(output)))
	}

	var mihomo *exec.Cmd
	if policy.Net.Mode == NetworkLimited {
		if err := waitForInterface("tap0", 10*time.Second); err != nil {
			fmt.Fprintf(os.Stderr, "init: slirp4netns 未在 10s 内创建 tap0: %v\n", err)
			return exitStartup
		}
		mihomo, err = startMihomo(policy)
		if err != nil {
			fmt.Fprintf(os.Stderr, "init: %v\n", err)
			return exitStartup
		}
		defer func() {
			if mihomo.Process != nil {
				_ = mihomo.Process.Signal(syscall.SIGTERM)
			}
		}()
	}

	argv := bwrapArgv(policy, *command)
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = envSlice(policy.Env)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if devNull, err := os.Open(os.DevNull); err == nil {
		cmd.Stdin = devNull
		defer devNull.Close()
	}
	err = cmd.Run()
	code := exitCodeOf(err, 1)
	if mihomo != nil {
		// 命令结束后收走过滤进程；即便它不响应，init 退出时的内核清理也会兜住
		_ = mihomo.Process.Signal(syscall.SIGTERM)
		_, _ = mihomo.Process.Wait()
	}
	return code
}

// netstackPrefix 标记"网络栈自身的诊断输出"（mihomo / slirp 的日志）。
// 宿主侧据此区分"命令的 stderr"（必须原样转发给用户）与"诊断"（只在 --verbose 时显示）。
const netstackPrefix = "[netstack] "

// startMihomo 起过滤进程并把它的输出接到自己的 stderr（宿主侧只看我们打印的
// readyMarker，不再耦合 mihomo 的日志文案），等网络接管完成。
func startMihomo(policy Policy) (*exec.Cmd, error) {
	configBase64, err := generateMihomoConfig(policy.Net.Allowlist, policy.Net.DNSServers, policy.Mihomo.MTU)
	if err != nil {
		return nil, err
	}
	home, err := os.MkdirTemp("", "sandbox-mihomo-")
	if err != nil {
		return nil, fmt.Errorf("建 mihomo 工作目录失败: %w", err)
	}
	readSide, writeSide, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("建 mihomo 输出管道失败: %w", err)
	}
	cmd := exec.Command(policy.Mihomo.Path, "-d", home, "-config", configBase64)
	cmd.Stdout = writeSide
	cmd.Stderr = writeSide
	if err := cmd.Start(); err != nil {
		writeSide.Close()
		readSide.Close()
		return nil, fmt.Errorf("启动 mihomo 失败: %w", err)
	}
	writeSide.Close()

	ready := make(chan struct{})
	var readyOnce bool
	go func() {
		defer readSide.Close()
		scanner := bufio.NewScanner(readSide)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
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
		return cmd, nil
	case <-time.After(readyTimeout):
		_ = cmd.Process.Kill()
		return nil, fmt.Errorf("mihomo 未在 20s 内完成网络接管")
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
