# native/sandbox（实验性原型，未接入）

pi-extensions 沙箱执行层的原生实现原型：Go，无第三方依赖，单一可执行文件。它要替代的是 TS 侧 `src/bwrap/` 里"从 bwrap 到网络栈"这一整段，**当前不接入任何现有代码路径**，只用于评估（对应 change：`openspec/changes/add-native-bwrap-executor/`）。

## 构建

```bash
cd native && go build -o /tmp/sandbox .
```

## 用法

```bash
sandbox run --policy '<json>' --command 'curl -sS https://pypi.org/simple/'
sandbox run --policy @policy.json --command '...' --timeout 30
sandbox run --policy-base64 "$(base64 -w0 policy.json)" --command '...'
sandbox run --policy @policy.json --command '...' --print-args   # 只打印 bwrap 命令行
```

策略字段：

```json
{
  "fs": {
    "readonly": ["/"],
    "readwrite": ["/tmp"],
    "deny": ["/home/me/.ssh/", "/home/me/.gitconfig"]
  },
  "network": {
    "mode": "limited",
    "allowlist": ["pypi.org", "*.pythonhosted.org", "example.com:443"],
    "dnsServers": ["223.5.5.5"]
  },
  "bwrap": { "path": "bwrap" },
  "mihomo": { "path": "mihomo", "mtu": 1500 },
  "slirp4netns": { "path": "slirp4netns" },
  "shell": "/bin/bash",
  "uid": 1000,
  "gid": 1000,
  "timeoutSeconds": 60,
  "env": { "HOME": "/home/me", "PATH": "/usr/local/bin:/usr/bin:/bin" }
}
```

`network.mode`：`limited`（TUN + 白名单 fakeip + deny-by-default）、`block`（`--unshare-net`，不建栈）、`allow-all`（不建栈）。

## 结构

| 文件        | 职责                                                               | TS 侧对应                                       |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| `main.go`   | supervisor：CLI、clone 出 init、slirp4netns、pidfd、输出分流、超时 | `sandbox.ts` + `network-stack.ts`（宿主侧部分） |
| `init.go`   | 新 ns 里的 PID 1：lo、等 tap0、起 mihomo、执行 bwrap 命令          | `holder.ts` + `exec.ts`                         |
| `pidfd.go`  | `pidfd_open`/`pidfd_send_signal`/`poll` 的裸 syscall 封装          | 无对应（TS 只能按 pid `kill`）                  |
| `mihomo.go` | allowlist → mihomo 配置（base64 直传）                             | `mihomo-config.ts`                              |
| `bwrap.go`  | bwrap argv 组装                                                    | `core.ts` 的 `buildBwrapArgs`                   |
| `policy.go` | 策略 JSON 解析、校验、默认值                                       | `core.ts` 的配置部分（放宽版）                  |

## 已验证（2026-10-12，宿主 linux/amd64，内核 6.12）

- allowlist 域名可直连：`curl https://pypi.org/simple/` → `200`。
- 非 allowlist 在 DNS 层被拒：`curl https://example.com` → `curl: (6) Could not resolve host`，退出码 6。
- `--timeout 3` 下的 `sleep 30` → 3 秒内终止，退出码 124，无残留进程。
- 起停开销：`--command true` 约 0.15s；进程链比 TS 版少 `unshare` 与 `nsenter`。

## 与原实现的差异（接入前需补齐）

- fs 保护策略：未实现 `PROTECTED_DIRS`、工作区 `.git` 递归只读保护、realpath 归一化。
- 审批 / `unapprovable`、输出截断与落盘、pendant 面板属于 TS 层职责，此处未实现。
- IP 条目的规则文本用 `IP-CIDR,…,no-resolve`，与 TS 版 `ipRule()` 的细节未逐一比对。
- 未做 mihomo / slirp4netns / bwrap 的 PATH 搜索策略与 DNS 服务器发现（由策略显式给出）。
- 未处理 PID 1 的子进程回收（命令结束时直接退出，由内核清理兜底）。
