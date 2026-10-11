// sandbox：pi-extensions 的原生沙箱执行层原型（Go，无第三方依赖）。
//
// 用法：
//
//	sandbox run --policy '<json>' --command 'curl -sS https://pypi.org/simple/'
//	sandbox run --policy-base64 <base64> --command '...' --timeout 30
//	sandbox run --policy @policy.json --command '...' --print-args
//
// 进程模型（见 design.md）：
//
//	supervisor（宿主 ns）
//	 ├─ init（CLONE_NEWUSER|NEWPID|NEWNS|NEWNET，新 ns 的 PID 1）→ mihomo + bwrap
//	 └─ slirp4netns（宿主 ns，fork 进 init 的 netns 提供 egress）
//
// 与 TS 版的区别集中在两处：命令直接在目标 netns 内执行（不需要 nsenter），
// 所有终止都经 pidfd（不存在 pid 复用窗口）。
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

	// readyMarker 是 init 在自己的 stderr 上打印的就绪标记。
	// 它取代了 TS 版"扫描 mihomo 的 Tun adapter listening 文案"的耦合。
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
	fmt.Fprint(os.Stderr, `sandbox run --policy <json|@file|-> --command '<shell command>'

  --policy <json>        策略 JSON（@file 读文件，- 读 stdin）
  --policy-base64 <b64>  策略的 base64(JSON)
  --command <string>     沙箱内执行的 shell 命令
  --cwd <dir>            命令执行目录（默认当前目录）
  --timeout <seconds>    超时（超时退出码 124）
  --print-args           只打印 bwrap 命令行，不执行
  --verbose              转发网络栈诊断输出
`)
}

func runSupervisor(args []string) int {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	policyArg := flags.String("policy", "", "")
	policyBase64 := flags.String("policy-base64", "", "")
	command := flags.String("command", "", "")
	cwdFlag := flags.String("cwd", "", "")
	timeoutFlag := flags.Int("timeout", 0, "")
	printArgs := flags.Bool("print-args", false, "")
	verbose := flags.Bool("verbose", false, "")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}

	policy, err := loadPolicy(*policyArg, *policyBase64)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return exitUsage
	}
	if *command == "" {
		fmt.Fprintln(os.Stderr, "--command 必填")
		return exitUsage
	}
	if *timeoutFlag > 0 {
		policy.TimeoutSeconds = *timeoutFlag
	}
	cwd := *cwdFlag
	if cwd == "" {
		if cwd, err = os.Getwd(); err != nil {
			fmt.Fprintf(os.Stderr, "取当前目录失败: %v\n", err)
			return exitUsage
		}
	}
	// 可执行文件在宿主侧解析成绝对路径，init 里直接复用（它已经在 userns 内）
	if policy.Bwrap.Path, err = resolveBinary(policy.Bwrap.Path); err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return exitStartup
	}
	if policy.Net.Mode == NetworkLimited {
		if policy.Mihomo.Path, err = resolveBinary(policy.Mihomo.Path); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			return exitStartup
		}
		if policy.Slirp.Path, err = resolveBinary(policy.Slirp.Path); err != nil {
			fmt.Fprintf(os.Stderr, "%v\n", err)
			return exitStartup
		}
	}
	if *printArgs {
		fmt.Println(printableArgv(bwrapArgv(policy, *command)))
		return 0
	}
	return runSandbox(policy, *command, cwd, *verbose)
}

func loadPolicy(arg string, encoded string) (Policy, error) {
	switch {
	case encoded != "":
		return parsePolicyBase64(encoded)
	case arg != "":
		return parsePolicyArg(arg)
	default:
		return Policy{}, fmt.Errorf("--policy 或 --policy-base64 必填")
	}
}

// runSandbox 起一次完整的沙箱：init（新 ns 的 PID 1）+ slirp4netns，用 pidfd 管理两者。
func runSandbox(policy Policy, command string, cwd string, verbose bool) int {
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

	initCmd := exec.Command(self, "internal-init", "--policy-base64", policyBase64,
		"--command", command, "--cwd", cwd)
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
	// exit-fd：init 持写端（它退出即关闭 → HUP），slirp4netns 持读端（-e 3）。
	// 用 ExtraFiles 传 fd 是语言层面的正常能力，不需要 TS 版那种 stdio[3]._handle.fd 私有字段。
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

	initPid := initCmd.Process.Pid
	initFd, err := pidfdOpen(initPid)
	if err != nil {
		fmt.Fprintf(os.Stderr, "warn: %v（退回按 pid 终止，仅用于诊断）\n", err)
	}

	waitCh := make(chan error, 1)
	go func() { waitCh <- initCmd.Wait() }()
	var waitErr error
	exited := false
	waitInit := func() error {
		if !exited {
			waitErr = <-waitCh
			exited = true
		}
		return waitErr
	}

	// 输出转发：stdout 原样透传（命令输出），stderr 逐行透传（诊断 + 就绪标记）
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
				// 网络栈自身日志：只在 --verbose 时展示
				if verbose {
					fmt.Fprintln(os.Stderr, line)
				}
			default:
				// 命令的 stderr：必须原样转发
				fmt.Fprintln(os.Stderr, line)
			}
		}
	}()

	var slirpCmd *exec.Cmd
	var slirpFd *pidfd
	if policy.Net.Mode == NetworkLimited {
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
			waitInit()
			return exitStartup
		}
		exitRead.Close()
		if fd, err := pidfdOpen(slirpCmd.Process.Pid); err == nil {
			slirpFd = fd
		}
	} else {
		exitRead.Close()
		defer stopProcess(slirpFd, nil)
	}

	timedOut := false
	if policy.Net.Mode == NetworkLimited {
		select {
		case <-readyCh:
		case <-time.After(readyTimeout):
			fmt.Fprintln(os.Stderr, "沙箱网络栈未在 20s 内就绪")
			_ = initFd.Send(syscall.SIGKILL)
			waitInit()
			wg.Wait()
			return exitStartup
		case <-waitCh:
			exited = true
			waitErr = <-waitCh
			wg.Wait()
			stopped := shutdownSandbox(initStdin, initFd, slirpFd, slirpCmd)
			_ = stopped
			fmt.Fprintf(os.Stderr, "沙箱 init 在就绪前退出（%v）\n", waitErr)
			return exitCodeOf(waitErr, exitStartup)
		}
	}

	// 命令阶段：超时先关 stdin（init 读到 EOF 自行退出 → 内核清理整个 ns），
	// 仍不退再 pidfd_send_signal（原子，没有 pid 复用窗口）
	if policy.TimeoutSeconds > 0 {
		select {
		case waitErr = <-waitCh:
			exited = true
		case <-time.After(time.Duration(policy.TimeoutSeconds) * time.Second):
			timedOut = true
			_ = initStdin.Close()
			select {
			case waitErr = <-waitCh:
				exited = true
			case <-time.After(stopGrace):
				if err := initFd.Send(syscall.SIGKILL); err != nil {
					fmt.Fprintf(os.Stderr, "warn: 终止 init 失败: %v\n", err)
				}
				waitErr = <-waitCh
				exited = true
			}
		}
	} else {
		waitErr = <-waitCh
		exited = true
	}
	_ = exited

	shutdownSandbox(initStdin, initFd, slirpFd, slirpCmd)
	wg.Wait()
	if timedOut {
		fmt.Fprintf(os.Stderr, "命令超过 %ds 未结束，已终止沙箱\n", policy.TimeoutSeconds)
		return exitTimeout
	}
	return exitCodeOf(waitErr, exitStartup)
}

// shutdownSandbox 释放两侧资源：init 的 stdin/pidfd、slirp4netns（先等 exit-fd HUP
// 让它自己退，超时才 pidfd 强杀）。
func shutdownSandbox(initStdin io.Closer, initFd *pidfd, slirpFd *pidfd, slirpCmd *exec.Cmd) bool {
	_ = initStdin.Close()
	defer initFd.Close()
	defer slirpFd.Close()
	if slirpCmd == nil {
		return true
	}
	if slirpFd != nil {
		if exited, err := slirpFd.exited(int(stopGrace.Milliseconds())); err == nil && exited {
			_ = slirpCmd.Wait()
			return true
		}
		slirpFd.kill(int(stopGrace.Milliseconds()))
	} else {
		_ = slirpCmd.Process.Signal(syscall.SIGTERM)
	}
	_ = slirpCmd.Wait()
	return true
}

// stopProcess 用于非 limited 模式（没有 slirp）时的收尾。
func stopProcess(fd *pidfd, cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	if fd != nil {
		defer fd.Close()
	}
	_ = cmd.Wait()
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
	var exitErr *exec.ExitError
	if ok := asExitError(err, &exitErr); ok {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok {
			if status.Signaled() {
				return 128 + int(status.Signal())
			}
			return status.ExitStatus()
		}
	}
	return fallback
}

func asExitError(err error, target **exec.ExitError) bool {
	exitErr, ok := err.(*exec.ExitError)
	if ok {
		*target = exitErr
	}
	return ok
}
