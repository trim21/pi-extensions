// mihomo 配置生成：把 allowlist 翻译成 TUN + 白名单 fakeip + deny-by-default 规则。
// 语义与 TS 版 src/bwrap/mihomo-config.ts 对齐（见那里的注释）。
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

const (
	fakeIPRange      = "198.18.0.1/16"
	rejectNameserver = "rcode://name_error"
	// 除 TUN 劫持外，DNS 还监听本机所有地址的 53：宿主 resolv.conf 指向 loopback
	// stub（如 systemd-resolved 的 127.0.0.53）时，这类查询不出网络设备、进不了 TUN，
	// dns-hijack 拦不到；监听本机地址让它们直达栈内解析器，策略与劫持路径一致。
	// 端口在 netns 内是隔离的，不占用宿主端口。
	dnsListen = "0.0.0.0:53"
)

// 合法 DNS 主机名（标签 1-63 字符，字母数字加连字符，不得以连字符开头/结尾）。
var domainPattern = regexp.MustCompile(`^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)

// 方括号包裹的 IPv6，可带 :port。
var bracketPattern = regexp.MustCompile(`^\[(.+)\](?::(\d+))?$`)

type allowlistEntry struct {
	host       string
	port       string
	subdomains bool
	isIP       bool
}

// parseAllowlistEntry 解析 `example.com`、`*.example.com`、`example.com:443`、
// `1.2.3.4`、`10.0.0.0/8`、`[::1]:443`。IPv6 必须用方括号包裹，裸 IPv6 报错并提示补方括号；
// 含 `*`、逗号、括号等规则注入字符的条目一律拒绝。
func parseAllowlistEntry(raw string) (allowlistEntry, error) {
	entry := allowlistEntry{}
	if raw == "*" {
		return entry, fmt.Errorf("allowlist 条目 %q: * 后面必须跟域名，例如 *.example.com", raw)
	}
	if strings.HasPrefix(raw, "*") && !strings.HasPrefix(raw, "*.") {
		return entry, fmt.Errorf("allowlist 条目 %q: * 必须占据完整的最左标签，例如 *.example.com", raw)
	}
	entry.subdomains = strings.HasPrefix(raw, "*.")
	body := raw
	if entry.subdomains {
		body = raw[len("*."):]
	}
	if body == "" {
		return entry, fmt.Errorf("allowlist 条目 %q: * 后面必须跟域名，例如 *.example.com", raw)
	}

	var host, port string
	if strings.HasPrefix(body, "[") {
		match := bracketPattern.FindStringSubmatch(body)
		if match == nil {
			return entry, fmt.Errorf("allowlist 条目 %q 非法", raw)
		}
		host = match[1]
		if match[2] != "" {
			normalized, err := parsePort(raw, match[2])
			if err != nil {
				return entry, err
			}
			port = normalized
		}
	} else if idx := strings.LastIndex(body, ":"); idx >= 0 {
		portPart := body[idx+1:]
		if !isDigits(portPart) {
			return entry, fmt.Errorf("allowlist 条目 %q 非法", raw)
		}
		host = body[:idx]
		if host == "" {
			return entry, fmt.Errorf("allowlist 条目 %q 非法", raw)
		}
		if strings.Contains(host, ":") {
			return entry, fmt.Errorf("allowlist 条目 %q: IPv6 必须用方括号包裹，例如 \"[%s]:%s\"", raw, host, portPart)
		}
		normalized, err := parsePort(raw, portPart)
		if err != nil {
			return entry, err
		}
		port = normalized
	} else {
		host = body
	}

	if strings.Contains(host, "*") {
		return entry, fmt.Errorf("allowlist 条目 %q: * 只能作为最左完整标签（*.example.com）", raw)
	}
	entry.host = host
	entry.port = port
	isIP, err := parseIPHost(host)
	if err != nil {
		return entry, fmt.Errorf("allowlist 条目 %q: %w", raw, err)
	}
	if isIP {
		if entry.subdomains {
			return entry, fmt.Errorf("allowlist 条目 %q: 通配前缀只能用于域名，IP 段请用 CIDR", raw)
		}
		entry.isIP = true
	} else if !domainPattern.MatchString(host) {
		return entry, fmt.Errorf("allowlist 条目 %q 非法", raw)
	}
	return entry, nil
}

// parseIPHost 判定 host 是否是合法 IP / CIDR 条目。用 netip 解析而不是正则：
// 正则按字符形态放行 `999.999.999.999`（八位组越界）与 `1.2.3.4.5`（段数不对），
// 它们既不是合法地址也不是 IP 段，MUST 直接拒绝，而不是当成 IPv4 或降级为域名。
func parseIPHost(host string) (bool, error) {
	if strings.Contains(host, "/") {
		if _, err := netip.ParsePrefix(host); err != nil {
			return false, fmt.Errorf("%q 不是合法的 IP 段", host)
		}
		return true, nil
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return true, nil
	}
	if looksLikeIP(host) {
		return false, fmt.Errorf("%q 不是合法的 IP 地址", host)
	}
	return false, nil
}

// looksLikeIP：含 `:`（IPv6 形态），或只由数字与点组成且含点（IPv4 形态）。
// 这类输入按 IP 对待，解析失败即报错，不允许悄悄降级成域名。
func looksLikeIP(host string) bool {
	if strings.Contains(host, ":") {
		return true
	}
	if !strings.Contains(host, ".") {
		return false
	}
	for _, r := range host {
		if (r < '0' || r > '9') && r != '.' {
			return false
		}
	}
	return true
}

// parsePort 校验端口范围并归一化（去掉前导零，与 TS 版 parsePort 返回 number 一致）。
func parsePort(raw string, value string) (string, error) {
	port, err := strconv.Atoi(value)
	if err != nil || port < 1 || port > 65535 {
		return "", fmt.Errorf("allowlist 条目 %q: 端口 %q 非法", raw, value)
	}
	return strconv.Itoa(port), nil
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

type builtRules struct {
	rules           []string
	fakeIPWhitelist []string
}

func buildRules(allowlist []string) (builtRules, error) {
	built := builtRules{}
	for _, raw := range allowlist {
		entry, err := parseAllowlistEntry(raw)
		if err != nil {
			return builtRules{}, err
		}
		if !entry.isIP {
			if entry.subdomains {
				built.fakeIPWhitelist = append(built.fakeIPWhitelist, "."+entry.host)
			} else {
				built.fakeIPWhitelist = append(built.fakeIPWhitelist, entry.host)
			}
			rule := "DOMAIN," + entry.host + ",DIRECT"
			if entry.subdomains {
				rule = "DOMAIN-WILDCARD,*." + entry.host + ",DIRECT"
			}
			built.rules = append(built.rules, withPort(rule, entry.port))
			continue
		}
		built.rules = append(built.rules, withPort(ipRule(entry.host), entry.port))
	}
	built.rules = append(built.rules, "MATCH,REJECT")
	return built, nil
}

// ipRule IP 条目的 mihomo 规则（IPv6 用 IP-CIDR6；no-resolve 跳过反向解析）。
func ipRule(host string) string {
	cidr := host
	if !strings.Contains(cidr, "/") {
		if strings.Contains(host, ":") {
			cidr = host + "/128"
		} else {
			cidr = host + "/32"
		}
	}
	kind := "IP-CIDR"
	if strings.Contains(cidr, ":") {
		kind = "IP-CIDR6"
	}
	return kind + "," + cidr + ",DIRECT,no-resolve"
}

func withPort(rule string, port string) string {
	if port == "" {
		return rule
	}
	return "AND,(" + rule + "),(DST-PORT," + port + ",DIRECT),DIRECT"
}

type mihomoDNS struct {
	Enable            bool     `json:"enable"`
	IPv6              bool     `json:"ipv6"`
	Listen            string   `json:"listen"`
	EnhancedMode      string   `json:"enhanced-mode"`
	FakeIPRange       string   `json:"fake-ip-range"`
	FakeIPFilterMode  string   `json:"fake-ip-filter-mode"`
	FakeIPFilter      []string `json:"fake-ip-filter,omitempty"`
	Nameserver        []string `json:"nameserver"`
	DefaultNameserver []string `json:"default-nameserver"`
	DirectNameserver  []string `json:"direct-nameserver"`
}

type mihomoTun struct {
	Enable              bool     `json:"enable"`
	Stack               string   `json:"stack"`
	MTU                 int      `json:"mtu"`
	AutoRoute           bool     `json:"auto-route"`
	StrictRoute         bool     `json:"strict-route"`
	AutoDetectInterface bool     `json:"auto-detect-interface"`
	DNSHijack           []string `json:"dns-hijack"`
}

type mihomoConfig struct {
	MixedPort     int       `json:"mixed-port"`
	Mode          string    `json:"mode"`
	LogLevel      string    `json:"log-level"`
	IPv6          bool      `json:"ipv6"`
	InterfaceName string    `json:"interface-name"`
	DNS           mihomoDNS `json:"dns"`
	Tun           mihomoTun `json:"tun"`
	Rules         []string  `json:"rules"`
}

// generateMihomoConfig 生成配置并返回 base64（mihomo 的 -config 直接吃 base64 JSON，
// 无需临时文件）。
func generateMihomoConfig(allowlist []string, dnsServers []string, mtu int) (string, error) {
	if len(dnsServers) == 0 {
		return "", fmt.Errorf("network.dnsServers 不能为空")
	}
	built, err := buildRules(allowlist)
	if err != nil {
		return "", err
	}
	config := mihomoConfig{
		MixedPort:     0,
		Mode:          "rule",
		LogLevel:      "info",
		IPv6:          false,
		InterfaceName: "tap0",
		DNS: mihomoDNS{
			Enable:            true,
			Listen:            dnsListen,
			EnhancedMode:      "fake-ip",
			FakeIPRange:       fakeIPRange,
			FakeIPFilterMode:  "whitelist",
			FakeIPFilter:      built.fakeIPWhitelist,
			Nameserver:        []string{rejectNameserver},
			DefaultNameserver: dnsServers,
			DirectNameserver:  dnsServers,
		},
		Tun: mihomoTun{
			Enable:              true,
			Stack:               "mixed",
			MTU:                 mtu,
			AutoRoute:           true,
			StrictRoute:         true,
			AutoDetectInterface: true,
			DNSHijack:           []string{"any:53"},
		},
		Rules: built.rules,
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("序列化 mihomo 配置: %w", err)
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}
