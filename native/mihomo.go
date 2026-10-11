// mihomo 配置生成：把 allowlist 翻译成 TUN + 白名单 fakeip + deny-by-default 规则。
// 语义与 TS 版 src/bwrap/mihomo-config.ts 对齐（见那里的注释）。
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"strconv"
	"strings"
)

const (
	fakeIPRange      = "198.18.0.1/16"
	rejectNameserver = "rcode://name_error"
)

type allowlistEntry struct {
	host       string
	port       string
	subdomains bool
	isIP       bool
}

// parseAllowlistEntry 解析 `example.com`、`*.example.com`、`example.com:443`、
// `1.2.3.4`、`10.0.0.0/8`、`[::1]:443`。
func parseAllowlistEntry(raw string) (allowlistEntry, error) {
	entry := allowlistEntry{}
	rest := raw
	if strings.HasPrefix(rest, "[") {
		end := strings.Index(rest, "]")
		if end < 0 {
			return entry, fmt.Errorf("allowlist 条目 %q: IPv6 缺少 ]", raw)
		}
		entry.host = rest[1:end]
		tail := rest[end+1:]
		if tail != "" {
			if !strings.HasPrefix(tail, ":") {
				return entry, fmt.Errorf("allowlist 条目 %q: ] 之后只能是 :port", raw)
			}
			entry.port = tail[1:]
		}
		entry.isIP = true
		return entry, validateEntry(raw, entry)
	}
	if idx := strings.LastIndex(rest, ":"); idx >= 0 {
		port := rest[idx+1:]
		if port != "" && isDigits(port) {
			entry.port = port
			rest = rest[:idx]
		}
	}
	if strings.HasPrefix(rest, "*.") {
		entry.subdomains = true
		rest = rest[2:]
	}
	if rest == "" {
		return entry, fmt.Errorf("allowlist 条目 %q 非法", raw)
	}
	entry.host = rest
	entry.isIP = net.ParseIP(rest) != nil || strings.Contains(rest, "/")
	return entry, validateEntry(raw, entry)
}

func validateEntry(raw string, entry allowlistEntry) error {
	if entry.port != "" {
		port, err := strconv.Atoi(entry.port)
		if err != nil || port <= 0 || port > 65535 {
			return fmt.Errorf("allowlist 条目 %q: 端口非法", raw)
		}
	}
	if entry.subdomains && entry.isIP {
		return fmt.Errorf("allowlist 条目 %q: 通配前缀只能用于域名", raw)
	}
	if strings.Contains(entry.host, "*") {
		return fmt.Errorf("allowlist 条目 %q: * 只能作为最左完整标签（*.example.com）", raw)
	}
	return nil
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

func ipRule(host string) string {
	cidr := host
	if !strings.Contains(cidr, "/") {
		if ip := net.ParseIP(host); ip != nil && ip.To4() == nil {
			cidr = host + "/128"
		} else {
			cidr = host + "/32"
		}
	}
	return "IP-CIDR," + cidr + ",DIRECT,no-resolve"
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
