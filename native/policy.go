// 策略（policy）：这个原型与 pi 项目解耦的输入契约。
// 命令行只吃一份自描述的 JSON，将来 TS 侧只需把 ResolvedBwrap 映射过来。
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

type NetworkMode string

const (
	NetworkLimited NetworkMode = "limited"
	NetworkBlock   NetworkMode = "block"
	NetworkAll     NetworkMode = "allow-all"
)

// FilePolicy 描述沙箱内的文件系统视角。
type FilePolicy struct {
	// Readonly 以 --ro-bind-try 绑定（默认整个 /）。
	Readonly []string `json:"readonly"`
	// Readwrite 以 --bind-try 绑定。
	Readwrite []string `json:"readwrite"`
	// Deny：以 / 结尾视为目录（挂空 tmpfs），否则视为文件（用 /dev/null 覆盖）。
	Deny []string `json:"deny"`
}

type NetworkPolicy struct {
	Mode NetworkMode `json:"mode"`
	// Allowlist 条目：域名、*.domain、IP/CIDR，均可带 :port。
	Allowlist []string `json:"allowlist"`
	// DNSServers 是上游真实 DNS（IPv4），供 mihomo 的 direct-nameserver 使用。
	DNSServers []string `json:"dnsServers"`
}

type BinaryPolicy struct {
	Path      string   `json:"path"`
	ExtraArgs []string `json:"extraArgs"`
}

type MihomoPolicy struct {
	Path string `json:"path"`
	MTU  int    `json:"mtu"`
}

// Policy 是一次 sandbox run 的完整输入。
type Policy struct {
	FS     FilePolicy    `json:"fs"`
	Net    NetworkPolicy `json:"network"`
	Bwrap  BinaryPolicy  `json:"bwrap"`
	Mihomo MihomoPolicy  `json:"mihomo"`
	Slirp  BinaryPolicy  `json:"slirp4netns"`
	// UID/GID 是沙箱内进程的身份，缺省沿用当前进程（与 TS 版 --uid/--gid 语义一致）。
	UID   *int   `json:"uid"`
	GID   *int   `json:"gid"`
	Shell string `json:"shell"`
	// Env 是沙箱内的环境变量；缺省是一份干净环境（不继承父进程）。
	Env            map[string]string `json:"env"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
}

// parsePolicyArg 支持三种写法：JSON 文本、@文件、- 表示 stdin。
func parsePolicyArg(arg string) (Policy, error) {
	raw, err := readPolicyText(arg)
	if err != nil {
		return Policy{}, err
	}
	return decodePolicy(raw)
}

func parsePolicyBase64(arg string) (Policy, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(arg))
	if err != nil {
		return Policy{}, fmt.Errorf("--policy-base64 不是合法的 base64: %w", err)
	}
	return decodePolicy(raw)
}

func readPolicyText(arg string) ([]byte, error) {
	switch {
	case arg == "-":
		return os.ReadFile("/dev/stdin")
	case strings.HasPrefix(arg, "@"):
		return os.ReadFile(strings.TrimPrefix(arg, "@"))
	default:
		return []byte(arg), nil
	}
}

func decodePolicy(raw []byte) (Policy, error) {
	var p Policy
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	// 未知键直接报错：策略是"我们控制的 schema"，写错键名应当可见
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&p); err != nil {
		return Policy{}, fmt.Errorf("解析策略失败: %w", err)
	}
	p.applyDefaults()
	if err := p.validate(); err != nil {
		return Policy{}, err
	}
	return p, nil
}

func (p *Policy) applyDefaults() {
	if p.Net.Mode == "" {
		p.Net.Mode = NetworkLimited
	}
	if len(p.FS.Readonly) == 0 {
		p.FS.Readonly = []string{"/"}
	}
	if p.Bwrap.Path == "" {
		p.Bwrap.Path = "bwrap"
	}
	if p.Mihomo.Path == "" {
		p.Mihomo.Path = "mihomo"
	}
	if p.Mihomo.MTU == 0 {
		p.Mihomo.MTU = 1500
	}
	if p.Slirp.Path == "" {
		p.Slirp.Path = "slirp4netns"
	}
	if p.Shell == "" {
		p.Shell = "/bin/bash"
	}
	if p.Env == nil {
		p.Env = map[string]string{
			"HOME":  os.Getenv("HOME"),
			"SHELL": "/bin/bash",
			"TERM":  "dumb",
			"LANG":  "C.UTF-8",
			"PATH":  "/usr/local/bin:/usr/bin:/bin",
		}
	}
	if p.UID == nil {
		uid := os.Getuid()
		p.UID = &uid
	}
	if p.GID == nil {
		gid := os.Getgid()
		p.GID = &gid
	}
}

func (p *Policy) validate() error {
	switch p.Net.Mode {
	case NetworkLimited:
		if len(p.Net.DNSServers) == 0 {
			return fmt.Errorf("network.mode=limited 需要至少一个 network.dnsServers")
		}
	case NetworkBlock, NetworkAll:
	default:
		return fmt.Errorf("network.mode 非法: %q（可选 limited / block / allow-all）", p.Net.Mode)
	}
	for _, entry := range p.Net.Allowlist {
		if strings.TrimSpace(entry) == "" {
			return fmt.Errorf("network.allowlist 含空条目")
		}
	}
	if len(p.FS.Deny) > 0 && len(p.FS.Readonly) == 0 {
		return fmt.Errorf("fs.deny 需要 fs.readonly 里至少有一个可绑定的根")
	}
	return nil
}

// resolveBinary 把策略里的路径解析成绝对路径（允许是 PATH 上的名字）。
func resolveBinary(path string) (string, error) {
	if strings.ContainsRune(path, '/') {
		if _, err := os.Stat(path); err != nil {
			return "", fmt.Errorf("可执行文件不可用: %s: %w", path, err)
		}
		return path, nil
	}
	found, err := exec.LookPath(path)
	if err != nil {
		return "", fmt.Errorf("在 PATH 上找不到 %s: %w", path, err)
	}
	return found, nil
}
