// mihomo 配置生成测试：allowlist 解析、规则构造与最终配置（逐字节）。
package main

import (
	"encoding/base64"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestParseAllowlistEntry(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want allowlistEntry
	}{
		{"裸域名", "example.com", allowlistEntry{host: "example.com"}},
		{"裸域名带端口", "example.com:443", allowlistEntry{host: "example.com", port: "443"}},
		{"子域名通配", "*.example.com", allowlistEntry{host: "example.com", subdomains: true}},
		{"子域名通配带端口", "*.example.com:8443", allowlistEntry{host: "example.com", port: "8443", subdomains: true}},
		{"IPv4", "1.2.3.4", allowlistEntry{host: "1.2.3.4", isIP: true}},
		{"IPv4 带端口", "1.2.3.4:8080", allowlistEntry{host: "1.2.3.4", port: "8080", isIP: true}},
		{"CIDR", "10.0.0.0/8", allowlistEntry{host: "10.0.0.0/8", isIP: true}},
		{"CIDR 带端口", "10.0.0.0/8:443", allowlistEntry{host: "10.0.0.0/8", port: "443", isIP: true}},
		{"方括号 IPv6", "[::1]", allowlistEntry{host: "::1", isIP: true}},
		{"方括号 IPv6 带端口", "[::1]:443", allowlistEntry{host: "::1", port: "443", isIP: true}},
		{"方括号 IPv6 CIDR", "[::1/128]", allowlistEntry{host: "::1/128", isIP: true}},
		{"端口前导零归一化", "example.com:0443", allowlistEntry{host: "example.com", port: "443"}},
		// 方括号只影响解析，不决定分类：包裹域名按域名处理（对齐 TS 行为）
		{"方括号包裹域名", "[example.com]", allowlistEntry{host: "example.com"}},
		// 纯数字但不含点：不是 IP 形态，按域名接受
		{"纯数字无点按域名", "12345", allowlistEntry{host: "12345"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseAllowlistEntry(tc.raw)
			if err != nil {
				t.Fatalf("parseAllowlistEntry(%q) 失败: %v", tc.raw, err)
			}
			if got != tc.want {
				t.Errorf("parseAllowlistEntry(%q) = %+v，期望 %+v", tc.raw, got, tc.want)
			}
		})
	}
}

func TestParseAllowlistEntryRejectsInvalid(t *testing.T) {
	cases := []struct {
		name string
		raw  string
	}{
		{"空条目", ""},
		{"只有通配", "*."},
		{"只有端口", ":443"},
		{"非数字端口", "example.com:abc"},
		{"端口超范围", "example.com:70000"},
		{"端口为零", "example.com:0"},
		{"裸 IPv6", "::1"},
		{"裸 IPv6 CIDR", "2001:db8::/32"},
		{"IPv6 缺右括号", "[::1"},
		{"右括号后非端口", "[::1]x"},
		{"右括号后空端口", "[::1]:"},
		{"空方括号", "[]"},
		{"通配用于 IP", "*.1.2.3.4"},
		{"通配用于 IP 段", "*.1.2.3.*"},
		{"通配不在最左标签", "a.*.example.com"},
		{"多层通配", "*.*.example.com"},
		{"通配不在完整标签", "*example.com"},
		{"注入逗号", "a,b.com"},
		{"注入规则括号", "evil.com),("},
		// IP 一律用 netip 解析：形态像 IP 但解析不过的条目必须报错，
		// 既不能当成合法 IPv4，也不能降级成域名
		{"IPv4 八位组越界", "999.999.999.999"},
		{"IPv4 段数过多", "1.2.3.4.5"},
		{"IPv4 段数不足", "1.2.3"},
		{"IPv4 前缀越界", "10.0.0.0/33"},
		{"IPv4 前缀非数字", "10.0.0.0/abc"},
		{"IPv6 前缀越界", "[2001:db8::/129]"},
		{"IPv6 地址非法", "[2001:db8:::1]"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := parseAllowlistEntry(tc.raw); err == nil {
				t.Fatalf("非法条目 %q 应当报错", tc.raw)
			}
		})
	}
}

func TestBuildRules(t *testing.T) {
	built, err := buildRules([]string{
		"pypi.org",
		"*.example.com",
		"example.com:443",
		"*.example.com:8443",
		"192.168.2.18",
		"192.168.2.18:8848",
		"10.0.0.0/8",
		"[::1]:80",
	})
	if err != nil {
		t.Fatalf("buildRules 失败: %v", err)
	}

	wantRules := []string{
		"DOMAIN,pypi.org,DIRECT",
		"DOMAIN-WILDCARD,*.example.com,DIRECT",
		"AND,(DOMAIN,example.com,DIRECT),(DST-PORT,443,DIRECT),DIRECT",
		"AND,(DOMAIN-WILDCARD,*.example.com,DIRECT),(DST-PORT,8443,DIRECT),DIRECT",
		"IP-CIDR,192.168.2.18/32,DIRECT,no-resolve",
		"AND,(IP-CIDR,192.168.2.18/32,DIRECT,no-resolve),(DST-PORT,8848,DIRECT),DIRECT",
		"IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
		"AND,(IP-CIDR6,::1/128,DIRECT,no-resolve),(DST-PORT,80,DIRECT),DIRECT",
		"MATCH,REJECT",
	}
	if !slices.Equal(built.rules, wantRules) {
		t.Errorf("rules 不符:\n got = %v\nwant = %v", built.rules, wantRules)
	}

	// 域名进 fake-ip 白名单（通配带前导点），IP/CIDR 不进；条目按出现顺序追加，
	// 通配条目出现两次就有两条（当前实现不做去重）
	wantFilter := []string{"pypi.org", ".example.com", "example.com", ".example.com"}
	if !slices.Equal(built.fakeIPWhitelist, wantFilter) {
		t.Errorf("fake-ip 白名单不符:\n got = %v\nwant = %v", built.fakeIPWhitelist, wantFilter)
	}

	last := built.rules[len(built.rules)-1]
	if last != "MATCH,REJECT" {
		t.Errorf("兜底规则应为 MATCH,REJECT，实际 %q", last)
	}
}

// TestBuildRulesIPv6 IPv6 必须生成 IP-CIDR6（mihomo 里 IP-CIDR 不接受 IPv6）；
// 无端口条目补 /128，带端口条目用 AND 包 DST-PORT。
func TestBuildRulesIPv6(t *testing.T) {
	built, err := buildRules([]string{"[::1]", "[2001:db8::1]:443"})
	if err != nil {
		t.Fatalf("buildRules 失败: %v", err)
	}
	want := []string{
		"IP-CIDR6,::1/128,DIRECT,no-resolve",
		"AND,(IP-CIDR6,2001:db8::1/128,DIRECT,no-resolve),(DST-PORT,443,DIRECT),DIRECT",
		"MATCH,REJECT",
	}
	if !slices.Equal(built.rules, want) {
		t.Errorf("rules 不符:\n got = %v\nwant = %v", built.rules, want)
	}
	// IPv6 是 IP 条目，不进 fake-ip 白名单
	if len(built.fakeIPWhitelist) != 0 {
		t.Errorf("IP 条目不应进 fake-ip 白名单，实际 %v", built.fakeIPWhitelist)
	}
}

// TestBuildRulesFakeIPWhitelist 只有域名进 fake-ip 白名单：带端口条目按域名收，
// 通配条目加前导点，IP/CIDR 一概不进。
func TestBuildRulesFakeIPWhitelist(t *testing.T) {
	built, err := buildRules([]string{
		"pypi.org",
		"example.com:443",
		"*.example.com",
		"192.168.2.18",
		"10.0.0.0/8",
	})
	if err != nil {
		t.Fatalf("buildRules 失败: %v", err)
	}
	want := []string{"pypi.org", "example.com", ".example.com"}
	if !slices.Equal(built.fakeIPWhitelist, want) {
		t.Errorf("fake-ip 白名单不符:\n got = %v\nwant = %v", built.fakeIPWhitelist, want)
	}
}

func TestBuildRulesEmptyAllowlist(t *testing.T) {
	built, err := buildRules(nil)
	if err != nil {
		t.Fatalf("buildRules 失败: %v", err)
	}
	if !slices.Equal(built.rules, []string{"MATCH,REJECT"}) {
		t.Errorf("空 allowlist 只应有 MATCH,REJECT，实际 %v", built.rules)
	}
	if len(built.fakeIPWhitelist) != 0 {
		t.Errorf("空 allowlist 不应有 fake-ip 白名单，实际 %v", built.fakeIPWhitelist)
	}
}

func TestBuildRulesPropagatesError(t *testing.T) {
	if _, err := buildRules([]string{"ok.example.com", "example.com:70000"}); err == nil {
		t.Fatal("非法条目应让 buildRules 报错")
	}
}

func TestGenerateMihomoConfigRejectsEmptyDNS(t *testing.T) {
	if _, err := generateMihomoConfig([]string{"pypi.org"}, nil, 1500); err == nil {
		t.Fatal("空 dnsServers 应当报错")
	}
}

// TestGenerateMihomoConfigGolden 逐字节锁定生成结果：base64 解码后与固定 JSON 相等。
func TestGenerateMihomoConfigGolden(t *testing.T) {
	encoded, err := generateMihomoConfig(
		[]string{"example.com", "*.pypi.org:443", "1.2.3.4", "10.0.0.0/8"},
		[]string{"223.5.5.5", "1.1.1.1"},
		1400,
	)
	if err != nil {
		t.Fatalf("generateMihomoConfig 失败: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("返回值不是合法 base64: %v", err)
	}
	want := `{"mixed-port":0,"mode":"rule","log-level":"info","ipv6":false,"interface-name":"tap0","dns":{"enable":true,"ipv6":false,"listen":"0.0.0.0:53","enhanced-mode":"fake-ip","fake-ip-range":"198.18.0.1/16","fake-ip-filter-mode":"whitelist","fake-ip-filter":["example.com",".pypi.org"],"nameserver":["rcode://name_error"],"default-nameserver":["223.5.5.5","1.1.1.1"],"direct-nameserver":["223.5.5.5","1.1.1.1"]},"tun":{"enable":true,"stack":"mixed","mtu":1400,"auto-route":true,"strict-route":true,"auto-detect-interface":true,"dns-hijack":["any:53"]},"rules":["DOMAIN,example.com,DIRECT","AND,(DOMAIN-WILDCARD,*.pypi.org,DIRECT),(DST-PORT,443,DIRECT),DIRECT","IP-CIDR,1.2.3.4/32,DIRECT,no-resolve","IP-CIDR,10.0.0.0/8,DIRECT,no-resolve","MATCH,REJECT"]}`
	if string(raw) != want {
		t.Errorf("配置 JSON 不符:\n got = %s\nwant = %s", raw, want)
	}
}

func TestGenerateMihomoConfigFields(t *testing.T) {
	encoded, err := generateMihomoConfig([]string{"pypi.org"}, []string{"192.168.2.1"}, 1500)
	if err != nil {
		t.Fatalf("generateMihomoConfig 失败: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("返回值不是合法 base64: %v", err)
	}
	var config mihomoConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		t.Fatalf("配置不是合法 JSON: %v", err)
	}

	if config.Mode != "rule" || config.InterfaceName != "tap0" {
		t.Errorf("顶层字段不符: %+v", config)
	}
	if config.DNS.EnhancedMode != "fake-ip" || config.DNS.FakeIPRange != "198.18.0.1/16" {
		t.Errorf("fake-ip 范围不符: %+v", config.DNS)
	}
	if config.DNS.FakeIPFilterMode != "whitelist" {
		t.Errorf("fake-ip 过滤模式应为 whitelist: %+v", config.DNS)
	}
	if config.DNS.Listen != "0.0.0.0:53" {
		t.Errorf("DNS 应监听本机地址的 53（宿主 loopback stub 的查询由此到达栈内）: %q", config.DNS.Listen)
	}
	if !slices.Equal(config.DNS.FakeIPFilter, []string{"pypi.org"}) {
		t.Errorf("fake-ip 白名单不符: %v", config.DNS.FakeIPFilter)
	}
	if !slices.Equal(config.DNS.Nameserver, []string{"rcode://name_error"}) {
		t.Errorf("nameserver 应为 DNS 层兜底拒绝: %v", config.DNS.Nameserver)
	}
	if !slices.Equal(config.DNS.DefaultNameserver, []string{"192.168.2.1"}) ||
		!slices.Equal(config.DNS.DirectNameserver, []string{"192.168.2.1"}) {
		t.Errorf("上游 DNS 不符: %+v", config.DNS)
	}
	if !slices.Equal(config.Tun.DNSHijack, []string{"any:53"}) {
		t.Errorf("dns-hijack 不符: %v", config.Tun.DNSHijack)
	}
	if config.Tun.MTU != 1500 || config.Tun.Stack != "mixed" || !config.Tun.Enable {
		t.Errorf("tun 配置不符: %+v", config.Tun)
	}
	if !slices.Equal(config.Rules, []string{"DOMAIN,pypi.org,DIRECT", "MATCH,REJECT"}) {
		t.Errorf("rules 不符: %v", config.Rules)
	}
}

// TestGenerateMihomoConfigOmitsEmptyFakeIPFilter 空 allowlist 时 fake-ip-filter 因
// omitempty 被省略（whitelist 模式下没有域名拿 fake IP，一切走默认拒绝）。
func TestGenerateMihomoConfigOmitsEmptyFakeIPFilter(t *testing.T) {
	encoded, err := generateMihomoConfig(nil, []string{"192.168.2.1"}, 1500)
	if err != nil {
		t.Fatalf("generateMihomoConfig 失败: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("返回值不是合法 base64: %v", err)
	}
	if strings.Contains(string(raw), `"fake-ip-filter":`) {
		t.Errorf("空 allowlist 不应输出 fake-ip-filter: %s", raw)
	}
	if !strings.Contains(string(raw), `"fake-ip-filter-mode":"whitelist"`) {
		t.Errorf("空 allowlist 仍应保留 whitelist 过滤模式: %s", raw)
	}
}
