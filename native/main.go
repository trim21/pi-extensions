// sandbox：pi-extensions 的沙箱执行器（Go，无第三方依赖）。
//
// 由 TS 侧调用（src/bwrap/executor.ts），也可以手工调试：
//
//	sandbox run --policy '<json>'
//	sandbox run --policy @policy.json --verbose
//	sandbox run --policy-base64 <base64> --timeout 30
//
// 调用方组装完整的 bwrap argv；执行器只负责 namespace、网络栈、进程身份（pidfd）
// 与执行。进程模型见 native/README.md 与 openspec/changes/wire-native-sandbox-executor/。
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	exitUsage   = 2
	exitTimeout = 124
	exitStartup = 125

	// netstackPrefix 标记"网络栈自身的诊断输出"：调用方据此与命令的 stderr 分流
	//（命令的 stderr 必须原样转发，诊断只在需要时展示）。
	netstackPrefix = "[netstack] "
	// readyMarker 是 init 打印的内部就绪信号——不依赖过滤进程的日志文案。
	readyMarker  = "sandbox: network stack ready"
	readyTimeout = 20 * time.Second
	stopGrace    = 2 * time.Second
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(exitUsage)
	}
	switch os.Args[1] {
	case "run":
		os.Exit(runSupervisor(os.Args[2:]))
	case "internal-init":
		os.Exit(runInit(os.Args[2:]))
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "未知子命令 %q\n", os.Args[1])
		usage()
		os.Exit(exitUsage)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `sandbox run --policy <json> [--timeout N] [--verbose]

  --policy <json>        策略 JSON（调用方直接传 argv，不经文件或 stdin）
  --policy-base64 <b64>  策略的 base64(JSON)
  --timeout <seconds>    命令超时（超时退出码 124）
  --verbose              展示网络栈诊断输出（[netstack] 前缀行）

策略是能力描述：root、mounts、extraArgs、network{mode,allowlist,dnsServers}、
mihomo{path,mtu}、slirp4netns{path}、bwrap{path}、command、shell、cwd、env、uid、gid、
timeoutSeconds。bwrap 参数与 namespace / 网络栈参数由执行器据此构造。
`)
}

func runSupervisor(args []string) int {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	policyArg := flags.String("policy", "", "")
	policyBase64 := flags.String("policy-base64", "", "")
	timeoutFlag := flags.Int("timeout", 0, "")
	verbose := flags.Bool("verbose", false, "")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}

	policy, err := loadPolicy(*policyArg, *policyBase64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return exitUsage
	}
	if *timeoutFlag > 0 {
		policy.TimeoutSeconds = *timeoutFlag
	}
	// 外部二进制在宿主侧解析成绝对路径：init 已经在新 namespace 里，
	// argv 也在那里构造，PATH 可能与宿主不同
	if policy.Bwrap.Path, err = resolveBinary(policy.Bwrap.Path); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return exitStartup
	}
	if policy.Network.Mode == NetworkLimited {
		if policy.Mihomo.Path, err = resolveBinary(policy.Mihomo.Path); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			return exitStartup
		}
		if policy.Slirp.Path, err = resolveBinary(policy.Slirp.Path); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			return exitStartup
		}
	}
	if err := requirePidfd(); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return exitStartup
	}
	return runSandbox(policy, *verbose)
}

func loadPolicy(arg string, encoded string) (Policy, error) {
	switch {
	case encoded != "":
		return parsePolicyBase64(encoded)
	case arg != "":
		return parsePolicy(arg)
	default:
		return Policy{}, fmt.Errorf("--policy 或 --policy-base64 必填")
	}
}

// requirePidfd 在启动阶段探测内核是否支持 pidfd。不支持就明确失败：退回"按 pid 发信号"
// 会把误伤无关进程的路径带回来（见 pidfd.go 的说明）。
func requirePidfd() error {
	fd, err := pidfdOpen(os.Getpid())
	if err != nil {
		return fmt.Errorf("内核不支持 pidfd（需要 Linux 5.3 及以上），无法安全终止沙箱进程: %w", err)
	}
	return fd.Close()
}

// runSandbox 起一次完整的沙箱：init（新 ns 的 PID 1）+ slirp4netns，用 pidfd 管理两者。
func runSandbox(policy Policy, verbose bool) int {
	self, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "定位自身可执行文件失败: %v\n", err)
		return exitStartup
	}
	policyBase64, err := encodePolicy(policy)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return exitStartup
	}

	initCmd := exec.Command(self, "internal-init", "--policy-base64", policyBase64)
	if policy.Cwd != "" {
		initCmd.Dir = policy.Cwd
	}
	initCmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags: syscall.CLONE_NEWUSER | syscall.CLONE_NEWPID | syscall.CLONE_NEWNS | syscall.CLONE_NEWNET,
		UidMappings: []syscall.SysProcIDMap{
			{ContainerID: 0, HostID: os.Getuid(), Size: 1},
		},
		GidMappings: []syscall.SysProcIDMap{
			{ContainerID: 0, HostID: os.Getgid(), Size: 1},
		},
		GidMappingsEnableSetgroups: false,
		Setpgid:                    true,
	}
	// 用自建 pipe 而不是 StdoutPipe：Cmd.Wait 不会去关闭它们，我们自己在子进程退出后读到 EOF
	initStdout, initStdoutWriter, err := os.Pipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "建 stdout 管道失败: %v\n", err)
		return exitStartup
	}
	initStderr, initStderrWriter, err := os.Pipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "建 stderr 管道失败: %v\n", err)
		return exitStartup
	}
	initCmd.Stdout = initStdoutWriter
	initCmd.Stderr = initStderrWriter
	initStdin, err := initCmd.StdinPipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "建 stdin 管道失败: %v\n", err)
		return exitStartup
	}
	// exit-fd：init 持写端（退出即关闭 → HUP），slirp4netns 持读端（-e 3）
	exitRead, exitWrite, err := os.Pipe()
	if err != nil {
		fmt.Fprintf(os.Stderr, "建 exit-fd 管道失败: %v\n", err)
		return exitStartup
	}
	initCmd.ExtraFiles = []*os.File{exitWrite}
	if err := initCmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "启动沙箱 init 失败: %v\n", err)
		return exitStartup
	}
	initStdoutWriter.Close()
	initStderrWriter.Close()
	// 父进程必须放掉自己的写端副本，否则 slirp4netns 永远等不到 HUP
	exitWrite.Close()

	// pidfd 必须在任何 Wait 之前打开：未 reap 的子进程是僵尸，pid 不会被内核复用，
	// 此时按 pid 打开内核引用一定指向这个子进程（顺序不能调换）。
	initPid := initCmd.Process.Pid
	initFd, err := pidfdOpen(initPid)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		_ = initCmd.Process.Kill()
		return exitStartup
	}
	defer initFd.Close()

	waitCh := make(chan error, 1)
	go func() { waitCh <- initCmd.Wait() }()

	// 输出流转发：stdout 原样透传（命令输出），stderr 逐行分流（诊断 vs 命令 stderr）
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, _ = io.Copy(os.Stdout, initStdout)
	}()
	readyCh := make(chan struct{})
	var readyOnce sync.Once
	wg.Add(1)
	go func() {
		defer wg.Done()
		scanner := bufio.NewScanner(initStderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.Contains(line, readyMarker):
				// 内部控制信号：不展示给用户
				readyOnce.Do(func() { close(readyCh) })
			case strings.HasPrefix(line, netstackPrefix):
				if verbose {
					fmt.Fprintln(os.Stderr, line)
				}
			default:
				// 命令的 stderr：必须原样转发
				fmt.Fprintln(os.Stderr, line)
			}
		}
		if err := scanner.Err(); err != nil {
			fmt.Fprintf(os.Stderr, "读取沙箱输出失败: %v\n", err)
		}
	}()

	var slirpCmd *exec.Cmd
	var slirpFd *pidfd
	if policy.Network.Mode == NetworkLimited {
		slirpCmd = exec.Command(policy.Slirp.Path,
			"-c",
			"--mtu="+strconv.Itoa(policy.Mihomo.MTU),
			"--userns-path=/proc/"+strconv.Itoa(initPid)+"/ns/user",
			"--netns-type=pid",
			strconv.Itoa(initPid),
			"tap0",
			"-e", "3",
		)
		slirpCmd.ExtraFiles = []*os.File{exitRead}
		if verbose {
			slirpCmd.Stdout = os.Stderr
			slirpCmd.Stderr = os.Stderr
		}
		if err := slirpCmd.Start(); err != nil {
			fmt.Fprintf(os.Stderr, "启动 slirp4netns 失败: %v\n", err)
			_ = initFd.Send(syscall.SIGKILL)
			<-waitCh
			return exitStartup
		}
		exitRead.Close()
		if fd, err := pidfdOpen(slirpCmd.Process.Pid); err == nil {
			slirpFd = fd
			defer slirpFd.Close()
		}
	} else {
		exitRead.Close()
	}

	timedOut := false
	if policy.Network.Mode == NetworkLimited {
		select {
		case <-readyCh:
		case <-time.After(readyTimeout):
			fmt.Fprintln(os.Stderr, "沙箱网络栈未在 20s 内就绪")
			_ = initFd.Send(syscall.SIGKILL)
			<-waitCh
			wg.Wait()
			return exitStartup
		case waitErr := <-waitCh:
			wg.Wait()
			shutdownSandbox(initStdin, slirpCmd, slirpFd)
			fmt.Fprintf(os.Stderr, "沙箱 init 在就绪前退出: %v\n", waitErr)
			return exitCodeOf(waitErr, exitStartup)
		}
	}

	// 命令阶段：超时先关 stdin（init 读到 EOF 自行退出 → 内核清理整个 ns），
	// 仍不退再 pidfd_send_signal（原子，没有 pid 复用窗口）
	var waitErr error
	if policy.TimeoutSeconds > 0 {
		select {
		case waitErr = <-waitCh:
		case <-time.After(time.Duration(policy.TimeoutSeconds) * time.Second):
			timedOut = true
			_ = initStdin.Close()
			select {
			case waitErr = <-waitCh:
			case <-time.After(stopGrace):
				if err := initFd.Send(syscall.SIGKILL); err != nil {
					fmt.Fprintf(os.Stderr, "warn: 终止 init 失败: %v\n", err)
				}
				waitErr = <-waitCh
			}
		}
	} else {
		waitErr = <-waitCh
	}

	shutdownSandbox(initStdin, slirpCmd, slirpFd)
	wg.Wait()
	if timedOut {
		fmt.Fprintf(os.Stderr, "命令超过 %ds 未结束，已终止沙箱\n", policy.TimeoutSeconds)
		return exitTimeout
	}
	return exitCodeOf(waitErr, exitStartup)
}

// shutdownSandbox 释放两侧资源：关掉 init 的 stdin（它读到 EOF 自行退出 → 内核清理
// pid namespace → exit-fd HUP → slirp4netns 自行退出）；只在该进程迟迟不退时才用 pidfd
// 强杀。等待用 exec.Cmd.Wait（标准库），不依赖 pidfd 的 poll。
func shutdownSandbox(initStdin io.Closer, slirpCmd *exec.Cmd, slirpFd *pidfd) {
	_ = initStdin.Close()
	if slirpCmd == nil {
		return
	}
	done := make(chan struct{})
	go func() {
		_ = slirpCmd.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(stopGrace):
		if slirpFd != nil {
			_ = slirpFd.Send(syscall.SIGKILL)
		}
		<-done
	}
}

func encodePolicy(policy Policy) (string, error) {
	raw, err := json.Marshal(policy)
	if err != nil {
		return "", fmt.Errorf("序列化策略失败: %w", err)
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

// exitCodeOf 把命令的结束状态折算成退出码（信号 → 128+signal）。
func exitCodeOf(err error, fallback int) int {
	if err == nil {
		return 0
	}
	exitErr, ok := err.(*exec.ExitError)
	if !ok {
		return fallback
	}
	status, ok := exitErr.Sys().(syscall.WaitStatus)
	if !ok {
		return fallback
	}
	if status.Signaled() {
		return 128 + int(status.Signal())
	}
	return status.ExitStatus()
}
