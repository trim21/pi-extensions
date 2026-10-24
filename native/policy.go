// 策略（policy）：执行器与调用方之间的契约，描述"要什么能力"，不描述"用什么参数"。
//
// 边界：TS 侧负责策略与路径语义（realpath 归一化、工作区保护目录、`.git` 只读保护），
// 因此这里的路径 MUST 已经是绝对路径；执行器负责把能力翻译成 bwrap 参数、namespace 与
// 网络栈参数——这份知识只在执行器一处，预览（print-args）与实际执行共用同一个构造函数。
package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type NetworkMode string

const (
	NetworkLimited NetworkMode = "limited"
	NetworkBlock   NetworkMode = "block"
	NetworkAll     NetworkMode = "allow-all"
)

// MountMode 是挂载语义而不是 bwrap 参数名：翻译成参数是执行器的事。
type MountMode string

const (
	// MountReadonly → 只读绑定该路径。
	MountReadonly MountMode = "ro"
	// MountReadonlyTry → 只读绑定，路径不存在时忽略该项。
	MountReadonlyTry MountMode = "ro-try"
	// MountReadwriteTry → 可写绑定，路径不存在时忽略该项。
	MountReadwriteTry MountMode = "rw-try"
	// MountDenyDir → 目录挂空（屏蔽目录内容）。
	MountDenyDir MountMode = "deny-dir"
	// MountDenyFile → 文件以空文件覆盖。
	MountDenyFile MountMode = "deny-file"
)

// Mount 是一条挂载计划；列表中靠后的覆盖靠前的。
type Mount struct {
	Path string    `json:"path"`
	Mode MountMode `json:"mode"`
}

type NetworkPolicy struct {
	Mode NetworkMode `json:"mode"`
	// Allowlist 条目：域名、*.domain、IP/CIDR，均可带 :port。
	Allowlist []string `json:"allowlist"`
	// DNSServers 是上游真实 DNS（IPv4），供 mihomo 的 direct-nameserver 使用。
	DNSServers []string `json:"dnsServers"`
}

type MihomoPolicy struct {
	Path string `json:"path"`
	MTU  int    `json:"mtu"`
}

type BinaryPolicy struct {
	Path string `json:"path"`
}

// Policy 是一次执行的完整输入。
type Policy struct {
	// Root 是基础只读根（默认 "/"）。
	Root string `json:"root"`
	// Mounts 是有序的附加挂载计划。
	Mounts []Mount `json:"mounts"`
	// ExtraArgs 是附加的 bwrap 参数（配置里的逃生口，追加在挂载计划之后）。
	ExtraArgs []string      `json:"extraArgs"`
	Network   NetworkPolicy `json:"network"`
	Mihomo    MihomoPolicy  `json:"mihomo"`
	Slirp     BinaryPolicy  `json:"slirp4netns"`
	Bwrap     BinaryPolicy  `json:"bwrap"`

	// Command 交给 `shell -lc` 执行的命令。
	Command string `json:"command"`
	Shell   string `json:"shell"`
	// Cwd 是命令进程的工作目录。
	Cwd string `json:"cwd"`
	// Env 是命令的完整环境（不继承调用方环境）。
	Env map[string]string `json:"env"`

	UID            *int `json:"uid"`
	GID            *int `json:"gid"`
	TimeoutSeconds int  `json:"timeoutSeconds"`
}

// parsePolicy 解析策略 JSON。策略只经 argv 传入（`--policy` 的 JSON 文本或
// `--policy-base64` 的 base64 文本）：调用方是程序，exec 直接传 argv 没有 shell 转义
// 问题；手工调试用 `--policy "$(cat policy.json)"` 即可，执行器不必再做"读文件 / 读 stdin"
// 这类额外入口。
func parsePolicy(raw string) (Policy, error) {
	var policy Policy
	decoder := json.NewDecoder(strings.NewReader(raw))
	// 未知键直接报错：策略是"我们控制的 schema"，写错键名应当可见
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return Policy{}, fmt.Errorf("解析策略失败: %w", err)
	}
	policy.applyDefaults()
	if err := policy.validate(); err != nil {
		return Policy{}, err
	}
	return policy, nil
}

// parsePolicyBase64 接收 base64(JSON)，便于调用方把策略塞进单个 argv 元素。
func parsePolicyBase64(arg string) (Policy, error) {
	decoded, err := base64.StdEncoding.DecodeString(strings.TrimSpace(arg))
	if err != nil {
		return Policy{}, fmt.Errorf("--policy-base64 不是合法的 base64: %w", err)
	}
	return parsePolicy(string(decoded))
}

func (p *Policy) applyDefaults() {
	if p.Root == "" {
		p.Root = "/"
	}
	if p.Network.Mode == "" {
		p.Network.Mode = NetworkLimited
	}
	if p.Mihomo.MTU == 0 {
		p.Mihomo.MTU = 1500
	}
	if p.Shell == "" {
		p.Shell = "/bin/bash"
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
	if !filepath.IsAbs(p.Root) {
		return fmt.Errorf("root 必须是绝对路径: %s", p.Root)
	}
	for _, mount := range p.Mounts {
		if !filepath.IsAbs(mount.Path) {
			return fmt.Errorf("挂载路径必须是绝对路径（路径语义由调用方归一化）: %s", mount.Path)
		}
		if _, err := mountArgs(mount); err != nil {
			return err
		}
	}
	if strings.TrimSpace(p.Command) == "" {
		return fmt.Errorf("command 不能为空")
	}
	if !filepath.IsAbs(p.Shell) {
		return fmt.Errorf("shell 必须是绝对路径: %s", p.Shell)
	}
	if p.Cwd != "" {
		info, err := os.Stat(p.Cwd)
		if err != nil {
			return fmt.Errorf("cwd 不可用: %s: %w", p.Cwd, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("cwd 不是目录: %s", p.Cwd)
		}
	}
	switch p.Network.Mode {
	case NetworkLimited:
		if len(p.Network.DNSServers) == 0 {
			return fmt.Errorf("network.mode=limited 需要至少一个 network.dnsServers")
		}
		if p.Mihomo.Path == "" {
			return fmt.Errorf("network.mode=limited 需要 mihomo.path")
		}
		if p.Slirp.Path == "" {
			return fmt.Errorf("network.mode=limited 需要 slirp4netns.path")
		}
	case NetworkBlock, NetworkAll:
	default:
		return fmt.Errorf("network.mode 非法: %q（可选 limited / block / allow-all）", p.Network.Mode)
	}
	for _, entry := range p.Network.Allowlist {
		if strings.TrimSpace(entry) == "" {
			return fmt.Errorf("network.allowlist 含空条目")
		}
	}
	for key := range p.Env {
		if strings.ContainsRune(key, '=') || strings.ContainsRune(key, '\x00') {
			return fmt.Errorf("env 键非法: %q", key)
		}
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
