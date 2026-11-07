// 策略解析测试：parsePolicy 的合法/非法输入与 applyDefaults 后的取值。
package main

import (
	"encoding/base64"
	"os"
	"testing"
)

func intPtr(v int) *int { return &v }

func TestParsePolicyRejectsUnknownFields(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"顶层未知字段", `{"command":"true","bogus":1}`},
		{"network 未知字段", `{"command":"true","network":{"mode":"block","bogus":1}}`},
		{"mount 未知字段", `{"command":"true","mounts":[{"path":"/tmp","mode":"ro","bogus":1}]}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parsePolicy(tc.raw); err == nil {
				t.Fatalf("未知字段应当被拒绝: %s", tc.raw)
			}
		})
	}
}

func TestParsePolicyRejectsRelativePaths(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"root 相对路径", `{"root":"relative","command":"true"}`},
		{"mount 相对路径", `{"command":"true","mounts":[{"path":"relative/dir","mode":"ro"}]}`},
		{"shell 相对路径", `{"command":"true","shell":"bash"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parsePolicy(tc.raw); err == nil {
				t.Fatalf("相对路径应当被拒绝: %s", tc.raw)
			}
		})
	}
}

func TestParsePolicyDefaults(t *testing.T) {
	policy, err := parsePolicy(`{"command":"echo hi","network":{"mode":"allow-all"}}`)
	if err != nil {
		t.Fatalf("解析合法策略失败: %v", err)
	}
	if policy.Root != "/" {
		t.Errorf("root 默认应为 /，实际 %q", policy.Root)
	}
	if policy.Shell != "/bin/bash" {
		t.Errorf("shell 默认应为 /bin/bash，实际 %q", policy.Shell)
	}
	if policy.Mihomo.MTU != 1500 {
		t.Errorf("mihomo.mtu 默认应为 1500，实际 %d", policy.Mihomo.MTU)
	}
	if policy.UID == nil || *policy.UID != os.Getuid() {
		t.Errorf("uid 默认应为当前 uid %d，实际 %v", os.Getuid(), policy.UID)
	}
	if policy.GID == nil || *policy.GID != os.Getgid() {
		t.Errorf("gid 默认应为当前 gid %d，实际 %v", os.Getgid(), policy.GID)
	}
	if policy.Network.Mode != NetworkAll {
		t.Errorf("network.mode 应为 allow-all，实际 %q", policy.Network.Mode)
	}
}

func TestParsePolicyExplicitValuesWinOverDefaults(t *testing.T) {
	policy, err := parsePolicy(`{
		"root": "/usr",
		"shell": "/bin/sh",
		"uid": 42,
		"gid": 43,
		"mihomo": {"mtu": 9000},
		"network": {"mode": "block"},
		"command": "true"
	}`)
	if err != nil {
		t.Fatalf("解析合法策略失败: %v", err)
	}
	if policy.Root != "/usr" || policy.Shell != "/bin/sh" {
		t.Errorf("显式 root/shell 未生效: %+v", policy)
	}
	if policy.UID == nil || *policy.UID != 42 || policy.GID == nil || *policy.GID != 43 {
		t.Errorf("显式 uid/gid 未生效: %v / %v", policy.UID, policy.GID)
	}
	if policy.Mihomo.MTU != 9000 {
		t.Errorf("显式 mtu 未生效: %d", policy.Mihomo.MTU)
	}
}

func TestParsePolicyNetworkModeDefaultsToLimited(t *testing.T) {
	policy, err := parsePolicy(`{
		"command": "true",
		"network": {"dnsServers": ["223.5.5.5"]},
		"mihomo": {"path": "/usr/bin/mihomo"},
		"slirp4netns": {"path": "/usr/bin/slirp4netns"}
	}`)
	if err != nil {
		t.Fatalf("解析合法策略失败: %v", err)
	}
	if policy.Network.Mode != NetworkLimited {
		t.Errorf("省略 network.mode 应默认 limited，实际 %q", policy.Network.Mode)
	}
	if policy.Mihomo.MTU != 1500 {
		t.Errorf("limited 模式下 mtu 默认应为 1500，实际 %d", policy.Mihomo.MTU)
	}
}

func TestParsePolicyRejectsInvalidNetworkMode(t *testing.T) {
	for _, mode := range []string{"bogus", "Limited", "allowall", "none"} {
		raw := `{"command":"true","network":{"mode":"` + mode + `"}}`
		if _, err := parsePolicy(raw); err == nil {
			t.Errorf("非法 network.mode %q 应当报错", mode)
		}
	}
}

func TestParsePolicyNetworkLimitedRequirements(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{
			"缺 dnsServers",
			`{"command":"true","network":{"mode":"limited"},"mihomo":{"path":"/usr/bin/mihomo"},"slirp4netns":{"path":"/usr/bin/slirp4netns"}}`,
		},
		{
			"缺 mihomo.path",
			`{"command":"true","network":{"mode":"limited","dnsServers":["223.5.5.5"]},"slirp4netns":{"path":"/usr/bin/slirp4netns"}}`,
		},
		{
			"缺 slirp4netns.path",
			`{"command":"true","network":{"mode":"limited","dnsServers":["223.5.5.5"]},"mihomo":{"path":"/usr/bin/mihomo"}}`,
		},
		{
			"allowlist 含空条目",
			`{"command":"true","network":{"mode":"block","allowlist":["pypi.org",""]}}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parsePolicy(tc.raw); err == nil {
				t.Fatalf("应当报错: %s", tc.name)
			}
		})
	}
}

func TestParsePolicyRejectsInvalidMountMode(t *testing.T) {
	raw := `{"command":"true","mounts":[{"path":"/tmp/x","mode":"write"}]}`
	if _, err := parsePolicy(raw); err == nil {
		t.Fatal("非法挂载模式应当报错")
	}
}

func TestParsePolicyRejectsEmptyCommand(t *testing.T) {
	for _, raw := range []string{
		`{"network":{"mode":"block"}}`,
		`{"command":"   ","network":{"mode":"block"}}`,
	} {
		if _, err := parsePolicy(raw); err == nil {
			t.Errorf("空 command 应当报错: %s", raw)
		}
	}
}

func TestParsePolicyCwd(t *testing.T) {
	dir := t.TempDir()
	valid := `{"command":"true","network":{"mode":"block"},"cwd":"` + dir + `"}`
	policy, err := parsePolicy(valid)
	if err != nil {
		t.Fatalf("已存在的 cwd 应当被接受: %v", err)
	}
	if policy.Cwd != dir {
		t.Errorf("cwd 未保留: %q", policy.Cwd)
	}

	if _, err := parsePolicy(`{"command":"true","network":{"mode":"block"},"cwd":"/nonexistent/pi-test-cwd"}`); err == nil {
		t.Error("不存在的 cwd 应当报错")
	}
}

func TestParsePolicyBase64(t *testing.T) {
	raw := `{"command":"true","network":{"mode":"block"}}`
	encoded := base64.StdEncoding.EncodeToString([]byte(raw))
	policy, err := parsePolicyBase64(encoded)
	if err != nil {
		t.Fatalf("合法 base64 策略应当解析成功: %v", err)
	}
	if policy.Network.Mode != NetworkBlock {
		t.Errorf("mode 未解析: %q", policy.Network.Mode)
	}

	// 允许首尾空白（argv 里可能被包了换行）
	if _, err := parsePolicyBase64("  " + encoded + "\n"); err != nil {
		t.Errorf("首尾空白应当被容忍: %v", err)
	}

	if _, err := parsePolicyBase64("!!!not-base64!!!"); err == nil {
		t.Error("非法 base64 应当报错")
	}
}

func TestParsePolicyRejectsInvalidEnvKey(t *testing.T) {
	if _, err := parsePolicy(`{"command":"true","network":{"mode":"block"},"env":{"A=B":"x"}}`); err == nil {
		t.Error("含 = 的 env 键应当报错")
	}
}
