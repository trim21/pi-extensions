# Design

## 为什么解耦成独立 CLI

原型要能脱离 pi 运行（手工跑、单测、与 TS 版对拍），所以接口是命令行 + 自描述策略 JSON，而不是"TS 侧的库"。接入阶段只需要 TS 侧把 `ResolvedBwrap` 映射成这份 policy 并 spawn 这个 CLI。

```
sandbox run --policy '<json>' --command 'curl -sS https://pypi.org/simple/'
```

- `--policy`：JSON 文本、`@file`、`-`（stdin）。
- `--policy-base64`：base64(JSON)，便于把配置塞进单个参数（免引号/换行问题）。
- `--command`、`--cwd`、`--timeout`、`--print-args`（打印 bwrap 命令行，用于与 TS 版对拍）。

## 进程模型

```
supervisor（宿主 ns，CLI 进程）
 ├─ init（CLONE_NEWUSER|NEWPID|NEWNS|NEWNET，新 ns 内的 PID 1）
 │    ├─ mihomo                 TUN + 白名单 fakeip + DNS 层拒绝
 │    └─ bwrap → bash -lc <cmd>  命令本体（已在目标 netns 内，不需要 nsenter）
 └─ slirp4netns（宿主 netns，fork 进 init 的 netns 提供 egress）
```

与 TS 版的差异：

| 事项           | TS 版                                                 | Go 原型                                             |
| -------------- | ----------------------------------------------------- | --------------------------------------------------- |
| PID 1 角色     | node `holder.js`                                      | 就是 CLI 自己（`internal-init` 子命令，同一二进制） |
| namespace 持有 | `unshare` 包装进程（信号被阻塞，只能 SIGKILL）        | `clone(CLONE_*)`，init 自己持有                     |
| 进 netns 方式  | `nsenter -U -n --preserve-credentials -t <holderPid>` | 无需进入：init 本来就跑在目标 ns 里                 |
| exit-fd 传递   | `holder.stdio[3]._handle.fd`（Node 私有 API）         | `cmd.ExtraFiles` → 子进程 fd 3                      |
| 等待退出       | `exit` 事件（`exitCode` 在 waitpid 后才更新）         | `poll(pidfd)`                                       |
| 终止           | `kill(2)`（检查与发信号之间有复用时隙）               | `pidfd_send_signal`（原子，无时隙）                 |

## 为什么必须 re-exec 自己

`internal-init` 是同一个二进制的另一个分支，不是重复实现。两个硬约束决定了它省不掉：

1. **pid namespace 的成员资格只在 fork 时生效**：`unshare(CLONE_NEWPID)` 与 `setns` 都不改变调用者，只影响它之后 fork 的子进程（内核里 `pidns_install` 设置的是 `pid_ns_for_children`）。所以"新 ns 里的 PID 1"必须由子进程来当，主进程无论如何做不到。TS 版同样是这个形态（`unshare` 建 ns、node holder 当 PID 1）。
2. **Go 里 fork 之后不能在子进程继续执行 Go 代码**：运行时是多线程的，`fork` 只复制调用线程。Go 里"让子进程成为 init 并继续执行我们的逻辑"只有 `fork + exec` 一条路——也就是 re-exec 自己。

对比 TS 版的三层（`unshare` 包装进程 + node holder + `nsenter`），现在是"一个二进制的两条分支"，命令直接跑在 init 所在的 netns 里。supervisor 必须留在宿主 ns（slirp4netns 需要在宿主 netns 启动才有正确的出站视角），因此"宿主侧 supervisor + 沙箱内 init"这个二分是架构的必然形态。

## 策略 JSON

```json
{
  "fs": {
    "readonly": ["/"],
    "readwrite": ["/tmp", "/home/me/project"],
    "deny": ["/home/me/.ssh/", "/home/me/.gitconfig"]
  },
  "network": {
    "mode": "limited",
    "allowlist": ["pypi.org", "*.pythonhosted.org", "example.com:443"],
    "dnsServers": ["223.5.5.5"]
  },
  "bwrap": { "path": "bwrap", "extraArgs": [] },
  "mihomo": { "path": "mihomo", "mtu": 1500 },
  "slirp4netns": { "path": "slirp4netns" },
  "uid": 1000,
  "gid": 1000,
  "timeoutSeconds": 60
}
```

`network.mode`：`limited`（建网络栈）、`block`（`--unshare-net`，不建栈）、`allow-all`（既不建栈也不 unshare）。fs 语义与 TS 版一致：`readonly` → `--ro-bind-try`，`readwrite` → `--bind-try`，`deny` 以 `/` 结尾 → `--tmpfs`，否则 → `--ro-bind-try /dev/null`。

## 终止与清理

1. 优雅：supervisor 关闭 init 的 stdin 写端 → init 读到 EOF 退出 → 内核清理 pid ns（mihomo 随之消失）→ init 持有的 exit-fd 写端关闭 → slirp4netns 收 HUP 退出。
2. 兜底（卡死 / 超时）：`pidfd_send_signal(initPidfd, SIGKILL)`，再 `pidfd_send_signal(slirpPidfd, SIGKILL)`——两条都是内核按进程发的，不存在 pid 复用问题。
3. 超时：`--timeout` 到点先 `pidfd_send_signal` 终止，退出码 124（与 `timeout(1)` 一致）。

## 原型的已知裁剪（接入阶段要补）

- fs 策略只做 bind/deny，不做 `PROTECTED_DIRS` 与 `.git` 递归只读保护、不做 realpath 归一化。
- 不做审批、不做 `unapprovable` 语义、不做输出截断/落盘/`pendant` 面板（这些属于 TS 层职责，保持原样）。
- 不做 DNS 服务器发现（策略里直接给 `dnsServers`），不做 mihomo/slirp/bwrap 的 PATH 搜索（策略里给路径或直接用 `PATH` 查找）。
- 不做"每条命令现建现停"之外的生命周期管理（原型就是一次 run 一条命令）。

## 接入路径（后续 change）

1. TS 侧把 `ResolvedBwrap` 映射成 policy JSON，`sandbox.ts` 改为 spawn CLI 并转发输出。
2. 迁移 fs 保护策略、诊断输出格式、`--print-args` 预览一致性测试。
3. 构建/发布：CI 加 Go 构建（linux/amd64、linux/arm64），二进制随包分发（`files` 加目录或 optionalDependencies 平台包）。
4. 删除 `holder.ts`/`holder.js`、`network-stack.ts`、`nsenter` 路径与相关测试。
