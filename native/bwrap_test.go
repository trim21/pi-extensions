// bwrap argv 构造测试：挂载语义 → 参数翻译，以及参数顺序（cwd 的落点在实现里）。
package main

import (
	"slices"
	"testing"
)

func TestMountArgs(t *testing.T) {
	cases := []struct {
		name    string
		mount   Mount
		want    []string
		wantErr bool
	}{
		{"ro", Mount{Path: "/data", Mode: MountReadonly}, []string{"--ro-bind", "/data", "/data"}, false},
		{"ro-try", Mount{Path: "/data", Mode: MountReadonlyTry}, []string{"--ro-bind-try", "/data", "/data"}, false},
		{"rw-try", Mount{Path: "/data", Mode: MountReadwriteTry}, []string{"--bind-try", "/data", "/data"}, false},
		{"deny-dir", Mount{Path: "/data/secret", Mode: MountDenyDir}, []string{"--tmpfs", "/data/secret"}, false},
		{"deny-file", Mount{Path: "/data/.gitconfig", Mode: MountDenyFile}, []string{"--ro-bind-try", "/dev/null", "/data/.gitconfig"}, false},
		{"未知模式", Mount{Path: "/data", Mode: "write"}, nil, true},
		{"相对路径", Mount{Path: "data", Mode: MountReadonly}, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := mountArgs(tc.mount)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("应当报错，实际得到 %v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("mountArgs 失败: %v", err)
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("mountArgs = %v，期望 %v", got, tc.want)
			}
		})
	}
}

// TestBuildBwrapArgvFull 用一条覆盖全部挂载模式与 extraArgs 的策略断言完整 argv，
// 从而同时锁定固定前缀/结尾、翻译结果与顺序。
func TestBuildBwrapArgvFull(t *testing.T) {
	policy := Policy{
		Root: "/",
		Mounts: []Mount{
			{Path: "/work", Mode: MountReadwriteTry},
			{Path: "/work/.git", Mode: MountReadonlyTry},
			{Path: "/work/.env", Mode: MountReadonly},
			{Path: "/root/.ssh", Mode: MountDenyDir},
			{Path: "/root/.gitconfig", Mode: MountDenyFile},
		},
		ExtraArgs: []string{"--clearenv"},
		Network:   NetworkPolicy{Mode: NetworkLimited},
		Shell:     "/bin/bash",
		Command:   "echo hi",
		UID:       intPtr(1000),
		GID:       intPtr(1000),
	}
	got, err := buildBwrapArgv(policy, "/usr/bin/bwrap")
	if err != nil {
		t.Fatalf("buildBwrapArgv 失败: %v", err)
	}
	want := []string{
		"/usr/bin/bwrap",
		"--ro-bind", "/", "/",
		"--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid",
		"--uid", "1000", "--gid", "1000",
		"--bind-try", "/work", "/work",
		"--ro-bind-try", "/work/.git", "/work/.git",
		"--ro-bind", "/work/.env", "/work/.env",
		"--tmpfs", "/root/.ssh",
		"--ro-bind-try", "/dev/null", "/root/.gitconfig",
		"--clearenv",
		"--dev", "/dev", "--proc", "/proc",
		"--", "/bin/bash", "-lc", "echo hi",
	}
	if !slices.Equal(got, want) {
		t.Errorf("argv 不符:\n got = %v\nwant = %v", got, want)
	}
}

// TestBuildBwrapArgvReadonlyAfterWritable 明确验证"靠后的覆盖靠前的"：只读保护
// 必须排在可写绑定之后。
func TestBuildBwrapArgvReadonlyAfterWritable(t *testing.T) {
	policy := Policy{
		Root: "/",
		Mounts: []Mount{
			{Path: "/work", Mode: MountReadwriteTry},
			{Path: "/work/.git", Mode: MountReadonlyTry},
		},
		Network: NetworkPolicy{Mode: NetworkLimited},
		Shell:   "/bin/bash",
		Command: "true",
		UID:     intPtr(0),
		GID:     intPtr(0),
	}
	argv, err := buildBwrapArgv(policy, "bwrap")
	if err != nil {
		t.Fatalf("buildBwrapArgv 失败: %v", err)
	}
	writable := slices.Index(argv, "--bind-try")
	readonly := slices.Index(argv, "--ro-bind-try")
	if writable < 0 || readonly < 0 {
		t.Fatalf("argv 缺少绑定参数: %v", argv)
	}
	if readonly < writable {
		t.Errorf("只读保护（index %d）应排在可写绑定（index %d）之后: %v", readonly, writable, argv)
	}
}

func TestBuildBwrapArgvBlockAddsUnshareNet(t *testing.T) {
	base := Policy{
		Root:    "/",
		Shell:   "/bin/bash",
		Command: "true",
		UID:     intPtr(0),
		GID:     intPtr(0),
	}

	limited := base
	limited.Network = NetworkPolicy{Mode: NetworkLimited}
	argv, err := buildBwrapArgv(limited, "bwrap")
	if err != nil {
		t.Fatalf("limited: %v", err)
	}
	if slices.Contains(argv, "--unshare-net") {
		t.Errorf("limited 模式不应加 --unshare-net: %v", argv)
	}

	for _, mode := range []NetworkMode{NetworkBlock, NetworkAll} {
		policy := base
		policy.Network = NetworkPolicy{Mode: mode}
		argv, err := buildBwrapArgv(policy, "bwrap")
		if err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		want := mode == NetworkBlock
		got := slices.Contains(argv, "--unshare-net")
		if got != want {
			t.Errorf("%s: --unshare-net = %v，期望 %v: %v", mode, got, want, argv)
		}
	}
}

// TestBuildBwrapArgvUnshareNetPlacement 锁定 --unshare-net 的位置：挂载计划之后、
// extraArgs 之前。
func TestBuildBwrapArgvUnshareNetPlacement(t *testing.T) {
	policy := Policy{
		Root:      "/",
		Mounts:    []Mount{{Path: "/work", Mode: MountReadwriteTry}},
		ExtraArgs: []string{"--clearenv"},
		Network:   NetworkPolicy{Mode: NetworkBlock},
		Shell:     "/bin/bash",
		Command:   "true",
		UID:       intPtr(0),
		GID:       intPtr(0),
	}
	argv, err := buildBwrapArgv(policy, "bwrap")
	if err != nil {
		t.Fatalf("buildBwrapArgv 失败: %v", err)
	}
	bind := slices.Index(argv, "--bind-try")
	unshare := slices.Index(argv, "--unshare-net")
	extra := slices.Index(argv, "--clearenv")
	dev := slices.Index(argv, "--dev")
	if !(bind < unshare && unshare < extra && extra < dev) {
		t.Errorf("顺序应为 挂载 < --unshare-net < extraArgs < --dev，实际 index: bind=%d unshare=%d extra=%d dev=%d: %v",
			bind, unshare, extra, dev, argv)
	}
}

// TestBuildBwrapArgvFixedPrefix 校验固定前缀，避免后续重构悄悄改变 namespace 语义。
func TestBuildBwrapArgvFixedPrefix(t *testing.T) {
	policy := Policy{
		Root:    "/",
		Network: NetworkPolicy{Mode: NetworkLimited},
		Shell:   "/bin/bash",
		Command: "true",
		UID:     intPtr(1000),
		GID:     intPtr(1001),
	}
	argv, err := buildBwrapArgv(policy, "/usr/bin/bwrap")
	if err != nil {
		t.Fatalf("buildBwrapArgv 失败: %v", err)
	}
	want := []string{
		"/usr/bin/bwrap",
		"--ro-bind", "/", "/",
		"--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid",
		"--uid", "1000", "--gid", "1001",
	}
	if len(argv) < len(want) || !slices.Equal(argv[:len(want)], want) {
		t.Errorf("固定前缀不符:\n got = %v\nwant = %v", argv, want)
	}
}

// TestBuildBwrapArgvSuffix 校验结尾：--dev/--proc/-- <shell> -lc <command>。
func TestBuildBwrapArgvSuffix(t *testing.T) {
	policy := Policy{
		Root:    "/",
		Network: NetworkPolicy{Mode: NetworkLimited},
		Shell:   "/usr/bin/zsh",
		Command: "curl -sS https://example.com",
		UID:     intPtr(0),
		GID:     intPtr(0),
	}
	argv, err := buildBwrapArgv(policy, "bwrap")
	if err != nil {
		t.Fatalf("buildBwrapArgv 失败: %v", err)
	}
	want := []string{"--dev", "/dev", "--proc", "/proc", "--", "/usr/bin/zsh", "-lc", "curl -sS https://example.com"}
	if len(argv) < len(want) || !slices.Equal(argv[len(argv)-len(want):], want) {
		t.Errorf("结尾不符:\n got = %v\nwant = %v", argv, want)
	}
}

// TestBuildBwrapArgvOmitsCwd 记录 cwd 的落点：策略里的 cwd 不翻译成 bwrap 参数，
// 而是由调用方设置 init 进程的工作目录（见 main.go 的 initCmd.Dir），bwrap 与命令继承它。
func TestBuildBwrapArgvOmitsCwd(t *testing.T) {
	policy := Policy{
		Root:    "/",
		Network: NetworkPolicy{Mode: NetworkLimited},
		Shell:   "/bin/bash",
		Command: "pwd",
		Cwd:     "/work",
		UID:     intPtr(0),
		GID:     intPtr(0),
	}
	argv, err := buildBwrapArgv(policy, "bwrap")
	if err != nil {
		t.Fatalf("buildBwrapArgv 失败: %v", err)
	}
	if slices.Contains(argv, "--chdir") || slices.Contains(argv, "/work") {
		t.Errorf("cwd 不应出现在 bwrap argv 里，应由调用方设置进程工作目录: %v", argv)
	}
}

// TestBuildBwrapArgvPropagatesMountError 确认非法挂载模式从构造阶段冒出来。
func TestBuildBwrapArgvPropagatesMountError(t *testing.T) {
	policy := Policy{
		Root:    "/",
		Mounts:  []Mount{{Path: "/work", Mode: "write"}},
		Network: NetworkPolicy{Mode: NetworkLimited},
		Shell:   "/bin/bash",
		Command: "true",
		UID:     intPtr(0),
		GID:     intPtr(0),
	}
	if _, err := buildBwrapArgv(policy, "bwrap"); err == nil {
		t.Fatal("非法挂载模式应当让 buildBwrapArgv 报错")
	}
}
