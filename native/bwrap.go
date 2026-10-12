// bwrap 命令行构造：把策略里的"能力描述"翻译成 bwrap 参数。
//
// 这份知识只存在于执行器一处——预览（print-args）与实际执行共用 buildBwrapArgv，
// 因此"打印出来的命令行"与"真正跑的命令行"不可能漂移。
package main

import (
	"fmt"
	"path/filepath"
	"strconv"
)

// mountArgs 把一条挂载语义翻译成 bwrap 参数。
func mountArgs(mount Mount) ([]string, error) {
	if !filepath.IsAbs(mount.Path) {
		return nil, fmt.Errorf("挂载路径必须是绝对路径: %s", mount.Path)
	}
	switch mount.Mode {
	case MountReadonly:
		return []string{"--ro-bind", mount.Path, mount.Path}, nil
	case MountReadonlyTry:
		return []string{"--ro-bind-try", mount.Path, mount.Path}, nil
	case MountReadwriteTry:
		return []string{"--bind-try", mount.Path, mount.Path}, nil
	case MountDenyDir:
		return []string{"--tmpfs", mount.Path}, nil
	case MountDenyFile:
		return []string{"--ro-bind-try", "/dev/null", mount.Path}, nil
	default:
		return nil, fmt.Errorf("未知挂载模式 %q（%s）", mount.Mode, mount.Path)
	}
}

// buildBwrapArgv 组装完整命令行：
//
//	bwrap --ro-bind <root> <root>
//	      --new-session --die-with-parent --unshare-user --unshare-pid --uid <uid> --gid <gid>
//	      <挂载计划...> [--unshare-net] <extraArgs>
//	      --dev /dev --proc /proc -- <shell> -lc <command>
//
// 参数顺序与语义与 TS 侧原实现一致：挂载计划靠后的覆盖靠前的（因此只读保护排在
// 可写绑定之后），extraArgs 追加在挂载计划之后、--dev/--proc 之前。
func buildBwrapArgv(policy Policy, bwrapPath string) ([]string, error) {
	argv := []string{bwrapPath, "--ro-bind", policy.Root, policy.Root}
	argv = append(argv,
		"--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid",
		"--uid", strconv.Itoa(*policy.UID), "--gid", strconv.Itoa(*policy.GID),
	)
	for _, mount := range policy.Mounts {
		args, err := mountArgs(mount)
		if err != nil {
			return nil, err
		}
		argv = append(argv, args...)
	}
	if policy.Network.Mode == NetworkBlock {
		argv = append(argv, "--unshare-net")
	}
	argv = append(argv, policy.ExtraArgs...)
	argv = append(argv, "--dev", "/dev", "--proc", "/proc", "--", policy.Shell, "-lc", policy.Command)
	return argv, nil
}
