# native/sandbox（原生沙箱执行器）

pi-extensions 沙箱执行层的原生实现：Go（唯一依赖是 `golang.org/x/sys`，Go 官方扩展库），
单一可执行文件。它承担 TS 侧 `src/bwrap/` 里"namespace + 网络栈 + 进程身份 + bwrap 参数构造 +
执行 + 超时"这一段；**TS 侧只描述能力**（挂载计划、网络策略、命令、环境），执行器决定
"用哪些 bwrap 参数与系统调用把它落地"。

接入计划见 `openspec/changes/wire-native-sandbox-executor/`。

## 构建

```bash
cd native && go build -o /tmp/sandbox .   # 需要 Go 1.26+（见 go.mod）
```

## 用法

```bash
sandbox run --policy '<json>'
sandbox run --policy "$(cat policy.json)"          # 手工调试
sandbox run --policy-base64 "$(base64 -w0 policy.json)"
sandbox run --policy '<json>' --timeout 30 --verbose
```

策略只经 argv 传入（`--policy` 的 JSON 文本或 `--policy-base64` 的 base64 文本）：调用方是
程序，exec 直接传 argv 没有 shell 转义问题，执行器不提供"读文件 / 读 stdin"这类额外入口。

```json
{
  "root": "/",
  "mounts": [
    { "path": "/home/me/project", "mode": "rw-try" },
    { "path": "/home/me/project/.git", "mode": "ro-try" },
    { "path": "/home/me/.ssh/", "mode": "deny-dir" },
    { "path": "/home/me/.gitconfig", "mode": "deny-file" }
  ],
  "network": { "mode": "limited", "allowlist": ["pypi.org"], "dnsServers": ["223.5.5.5"] },
  "mihomo": { "path": "mihomo", "mtu": 1500 },
  "slirp4netns": { "path": "slirp4netns" },
  "bwrap": { "path": "bwrap" },
  "command": "curl -sS https://pypi.org/simple/",
  "shell": "/bin/bash",
  "cwd": "/tmp",
  "env": { "HOME": "/home/me", "PATH": "/usr/local/bin:/usr/bin:/bin" },
  "uid": 1000,
  "gid": 1000,
  "timeoutSeconds": 60
}
```

- `mounts` 是**能力描述**而不是 bwrap 参数名：`ro` / `ro-try` / `rw-try` / `deny-dir` /
  `deny-file` 由执行器翻译成 `--ro-bind` / `--ro-bind-try` / `--bind-try` / `--tmpfs` /
  `/dev/null` 覆盖。列表有序，靠后的覆盖靠前的（只读保护因此排在可写绑定之后）。
- 路径 MUST 已经是绝对路径：realpath 归一化、`~`/`.` 展开、`PROTECTED_DIRS` 与工作区 `.git`
  的识别都在 TS 侧完成，执行器不做路径语义推断。
- `command` + `shell`：执行器组装 `-- <shell> -lc <command>`；`env` 是命令的完整环境（不继承）。
- `network.mode`：`limited` 建网络栈；`block`（`--unshare-net`）与 `allow-all` 都不建栈。
- 退出码：命令退出码透传（被信号杀 → `128+n`）、超时 `124`、启动失败 `125`、用法错误 `2`。
- 输出分流：命令的 stdout/stderr 原样转发；网络栈自身日志带 `[netstack] ` 前缀，仅 `--verbose` 展示。

## 进程模型

```
supervisor（宿主 ns，CLI 进程）
 ├─ init（CLONE_NEWUSER|NEWPID|NEWNS|NEWNET，新 ns 内的 PID 1）
 │    ├─ mihomo                      TUN + 白名单 fakeip + DNS 层拒绝 + 本机 53 监听
 │    └─ bwrap → shell -lc <command>  命令本体（已在目标 netns 内，不需要 nsenter）
 └─ slirp4netns（宿主 netns，fork 进 init 的 netns 提供 egress）
```

与 TS 版的差异：

| 事项           | TS 版                                           | 本执行器                        |
| -------------- | ----------------------------------------------- | ------------------------------- |
| PID 1 角色     | node `holder.js`                                | 同一二进制的 `internal-init`    |
| namespace 持有 | `unshare` 包装进程（信号被阻塞，只能 SIGKILL）  | `clone(CLONE_*)`，init 自己持有 |
| 进 netns 方式  | `nsenter -U -n --preserve-credentials -t <pid>` | 无需进入：init 就在目标 ns 里   |
| exit-fd 传递   | `holder.stdio[3]._handle.fd`（Node 私有 API）   | `cmd.ExtraFiles` → 子进程 fd 3  |
| 等待退出       | `exit` 事件（`exitCode` 在 waitpid 后才更新）   | `exec.Cmd.Wait`                 |
| 终止           | `kill(2)`（检查与发信号之间有复用时隙）         | `pidfd_send_signal`（原子）     |

### 为什么必须 re-exec 自己

1. **pid namespace 的成员资格只在 fork 时生效**：`unshare(CLONE_NEWPID)` 与 `setns` 都不改变
   调用者，只影响它之后 fork 的子进程（内核里 `pidns_install` 设置的是 `pid_ns_for_children`）。
   所以"新 ns 里的 PID 1"必须由子进程担当，主进程做不到。
2. **Go 里 fork 之后不能在子进程继续执行 Go 代码**（运行时是多线程的，`fork` 只复制调用线程），
   因此"让子进程成为 init 并继续跑我们的逻辑"只有 `fork + exec` 一条路。

### pidfd：终止为什么没有 TOCTOU

- `pidfd_open(pid)` 是**按 pid 查进程**，本身有 TOCTOU——但对**尚未 reap 的子进程**是精确的：
  内核只在 task 完全释放时才归还 pid 号，僵尸仍占着号，映射唯一且稳定（实测：未 reap 的子进程
  `State: Z` 时 `pidfd_open` 成功；`Wait4` 收尸后再 open 返回 `ESRCH`，此刻若号码已被复用就会
  落到别人身上）。
- 因此有两条不变量：**pidfd 一律在 `Start()` 之后、任何 `Wait()` 之前打开**；**绝不对已收尸的
  pid 或不是自己 spawn 的 pid 用 `pidfd_open` 冒充身份**。
- 代码里不存在按 pid 发信号的路径：supervisor 用 pidfd 管 init 与 slirp4netns，init 也用 pidfd 管
  mihomo；`pidfd_open` 不支持时启动阶段直接失败（`requirePidfd`），不做"退回按 pid"的降级。
- `pidfd_open` 没有 CLOEXEC 选项，fd 必须自己设（见 `pidfd.go`），否则会被后续子进程继承。

## 最低内核

| 能力                            | 最低内核                   |
| ------------------------------- | -------------------------- |
| `pidfd_send_signal`             | 5.1                        |
| **`pidfd_open`**                | **5.3**                    |
| `CLONE_NEWUSER` + uid/gid 映射  | 3.5（`setgroups` 需 3.19） |
| `CLONE_NEWPID` / `CLONE_NEWNET` | 2.6.24                     |
| netns 内 TUN（mihomo 需要）     | 2.6.24                     |

**结论：5.3（实践建议 5.10+ LTS）**。比内核更常见的阻碍是：非特权 userns 是否被允许
（Ubuntu 24.04+ 默认有 AppArmor 限制，未带 profile 的二进制会被拒）、`/dev/net/tun` 是否可用、
以及 `mihomo` / `slirp4netns` / `bwrap` 三个外部二进制是否在位。

## 已验证（2026-10-12，宿主 linux/amd64，内核 6.12）

- allowlist 域名可直连：`200`。
- 非 allowlist 在 DNS 层被拒：`curl: (6) Could not resolve host`，退出码 6。
- `--timeout 3` 下的 `sleep 30`：3 秒内终止，退出码 124，无残留进程（`pgrep -x mihomo` 无匹配）。
- 起停开销约 0.15s；`go vet` / `gofmt` 干净。

## 文件

| 文件        | 职责                                                                        |
| ----------- | --------------------------------------------------------------------------- |
| `main.go`   | supervisor：flag、clone 出 init、slirp4netns、pidfd、输出分流、超时         |
| `init.go`   | 新 ns 的 PID 1：lo、等 tap0、起 mihomo、执行构造好的 bwrap 命令行           |
| `bwrap.go`  | 挂载计划 → bwrap argv（这份知识只此一处）                                   |
| `mihomo.go` | allowlist → mihomo 配置（base64 直传）                                      |
| `pidfd.go`  | `pidfd_open` / `pidfd_send_signal` 封装（`golang.org/x/sys/unix`）+ CLOEXEC |
| `policy.go` | 策略（能力描述）解析、校验、默认值                                          |

## 与旧实现的关系

本执行器替代 `src/bwrap/network-stack.ts`、`src/bwrap/holder.ts`（及产物 `holder.js`）、
`exec.ts` 的进程 spawn / `nsenter` 前缀 / `buildBwrapInvocation` / `invocationArgv`，以及
`mihomo-config.ts` 的配置生成。`--print-args` 预览随本次改动删除（其"网络栈相关"的部分在预览
阶段只能是占位符，消费者只有 CLI 与它自己的单测）。TS 侧保留配置解析、审批与输出/诊断呈现。
完整迁移步骤见 `openspec/changes/wire-native-sandbox-executor/tasks.md`。
