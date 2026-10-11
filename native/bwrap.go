// bwrap 命令行组装：与 TS 版 src/bwrap/core.ts 的 buildBwrapArgs 语义一致
// （readonly → --ro-bind-try，readwrite → --bind-try，deny 目录 → --tmpfs、
// deny 文件 → /dev/null 覆盖）。原型的裁剪见 design.md。
package main

import (
	"strconv"
	"strings"
)

func buildBwrapArgs(policy Policy) []string {
	args := []string{"--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid"}
	args = append(args, "--uid", strconv.Itoa(*policy.UID), "--gid", strconv.Itoa(*policy.GID))
	for _, path := range policy.FS.Readonly {
		args = append(args, "--ro-bind-try", path, path)
	}
	for _, path := range policy.FS.Readwrite {
		args = append(args, "--bind-try", path, path)
	}
	for _, path := range policy.FS.Deny {
		if strings.HasSuffix(path, "/") {
			args = append(args, "--tmpfs", path)
		} else {
			args = append(args, "--ro-bind-try", "/dev/null", path)
		}
	}
	if policy.Net.Mode == NetworkBlock {
		args = append(args, "--unshare-net")
	}
	args = append(args, "--dev", "/dev", "--proc", "/proc")
	args = append(args, policy.Bwrap.ExtraArgs...)
	return args
}

// bwrapArgv 是完整命令行：bwrap + 挂载参数 + `-- shell -lc command`。
func bwrapArgv(policy Policy, command string) []string {
	argv := []string{policy.Bwrap.Path}
	argv = append(argv, buildBwrapArgs(policy)...)
	argv = append(argv, "--", policy.Shell, "-lc", command)
	return argv
}

// printableArgv 用于 --print-args：把 argv 渲染成可直接复制执行的一行。
func printableArgv(argv []string) string {
	quoted := make([]string, 0, len(argv))
	for _, arg := range argv {
		if strings.ContainsAny(arg, " \t\"'\\$`") {
			quoted = append(quoted, "'"+strings.ReplaceAll(arg, "'", `'\''`)+"'")
			continue
		}
		quoted = append(quoted, arg)
	}
	return strings.Join(quoted, " ")
}
