# Design

## 职责边界

| 仍属于 TS                                                        | 交给原生执行器                        |
| ---------------------------------------------------------------- | ------------------------------------- |
| 配置加载/合并与 schema 校验（`core.ts`）                         | 创建 user/pid/mount/net namespace     |
| 审批、`unapprovable`、沙箱模式决策（`runtime.ts`、`approval-*`） | 网络栈：slirp4netns + mihomo 生命周期 |
| fs 策略、realpath 归一化、挂载计划生成（`core.ts`）              | egress 接口就绪等待、过滤进程就绪判定 |
| 输出截断/落盘、诊断出口、pendant 面板                            | bwrap argv 构造（`native/bwrap.go`）  |
| 策略序列化与执行器调用、退出码映射                               | 目标 netns 内执行 argv、转发退出码    |
|                                                                  | 进程身份与终止（pidfd）、超时兜底     |
|                                                                  | 内核级清理（pid namespace init 退出） |

argv 构造放在执行器里：TS 只描述"要什么能力"（挂载计划、网络策略、命令、环境），执行器决定
"用哪些 bwrap 参数表达"——这份知识只在 `native/bwrap.go` 一处，避免两侧各懂一半。

`--print-args` 预览随本次改动删除：它比 `--verbose` 多给的只有 argv 本身，而其中"网络栈相关"
的部分（nsenter 前缀、holder pid）在预览时只能是占位符，价值有限；消费者只有 CLI 与它自己的
单测，Bash 工具不依赖。

## policy 形态

```json
{
  "root": "/",
  "mounts": [
    { "path": "/home/me/project", "mode": "rw-try" },
    { "path": "/home/me/project/.git", "mode": "ro-try" },
    { "path": "/home/me/.ssh/", "mode": "deny-dir" }
  ],
  "network": { "mode": "limited", "allowlist": ["pypi.org"], "dnsServers": ["223.5.5.5"] },
  "mihomo": { "path": "/path/to/mihomo", "mtu": 1500 },
  "slirp4netns": { "path": "/path/to/slirp4netns" },
  "bwrap": { "path": "/path/to/bwrap" },
  "command": "curl -sS https://pypi.org/simple/",
  "shell": "/bin/bash",
  "cwd": "/home/me/project",
  "env": { "HOME": "/home/me", "PATH": "/usr/local/bin:/usr/bin:/bin" },
  "uid": 1000,
  "gid": 1000,
  "timeoutSeconds": 30
}
```

- `mounts` 是**能力描述**而非 bwrap 参数：`ro` / `ro-try` / `rw-try` / `deny-dir` / `deny-file` 由执行器翻译成 `--ro-bind` / `--ro-bind-try` / `--bind-try` / `--tmpfs` / `/dev/null` 覆盖；列表有序，靠后的覆盖靠前的（只读保护因此排在可写绑定之后）。
- 路径 MUST 已经是绝对路径：realpath 归一化、"`.`/`~` 展开"、`PROTECTED_DIRS` 与工作区 `.git` 的识别都在 TS 侧完成，执行器不做路径语义推断。
- `command` + `shell`：执行器组装 `-- <shell> -lc <command>`；`env` 是命令的完整环境（不继承）。
- `network.mode=limited` 时执行器建栈；`block`/`allow-all` 时不建栈（`block` 的 `--unshare-net` 由执行器加）。
- DNS 服务器由 TS 读取（沿用现有 `resolveDnsServers` 逻辑，迁到 `core.ts` 或保留在调用侧），执行器不自行发现。
- 二进制路径由 TS 解析（`PATH` 查找 + 配置覆盖），执行器不搜索 `PATH`。

## 接口契约（实现者照此执行）

### 执行器 CLI

- 二进制：`bin/native/linux-x64/sandbox`、`bin/native/linux-arm64/sandbox`（随包分发）。开发期允许
  用环境变量 `PI_SANDBOX_BINARY` 覆盖；找不到二进制时明确失败，不降级回 JS 实现。
- 调用：`<binary> run --policy-base64 <b64> [--timeout <seconds>] [--verbose]`。策略用 base64 传，
  避免命令行长度与转义问题；`--policy <json>` 保留给手工调试。
- **stdin 是控制通道**：TS 关掉执行器 stdin 表示"请优雅停"（执行器读到 EOF 走内核级清理后退出）。
  命令本身不读 stdin（执行器把命令的 stdin 接到 `/dev/null`）。
- stdout = 命令的 stdout；stderr = 命令的 stderr + 执行器诊断（诊断行带 `[netstack] ` 前缀）。
- 无就绪握手：命令由执行器内部执行，TS 不需要"网络已就绪"信号；`--verbose` 的诊断只给人看。
- 崩溃诊断：执行器非正常终止（还没执行命令就退出，或运行期异常）时把原因写到 stderr；TS 侧统一
  落盘（沿用 `writeFailureLog` 的目录与格式），命令失败时把路径附进 `sandboxHint`。

### TS 侧边界

- 新增 `src/bwrap/executor.ts`：定位二进制 + 序列化 policy + spawn + 转发 stdout/stderr + 退出码
  映射（124 → `TimeoutError`、125 → 启动失败、2 → 内部错误）+ abort（先关 stdin，短暂等待，再
  `SIGTERM`，最后 `SIGKILL`）。
- `src/bwrap/sandbox.ts`：`runInSandbox` 改为驱动执行器；保留 `SandboxRunResult`、`networkStackLog`、
  `onData` 语义；删除 `previewSandboxCommand`、`HOLDER_PID_PLACEHOLDER`。
- `src/bwrap/core.ts`：`buildBwrapArgs` → 产出**挂载计划**（`root` + 有序 `mounts`，路径绝对化）；
  删除 `createNetworkStack`、`findMihomo`、`findSlirp4netns`；`resolveDnsServers` 留在 TS。
- `src/bwrap/runtime.ts` 与 `approval-*`：审批、`sandboxHint`、输出截断/落盘不动。
- 删除：`src/bwrap/{network-stack.ts,holder.ts,holder.js,mihomo-config.ts}`、`exec.ts` 的
  nsenter/spawn/`buildBwrapInvocation`/`invocationArgv`、`bin/sandbox.ts --print-args`、
  `package.json` 的 `build:holder`。
- Go 侧单测放 `native/*_test.go`（`go test ./...`）。

## 退出码与取消语义

| 情况                  | 退出码                     | TS 侧映射                            |
| --------------------- | -------------------------- | ------------------------------------ |
| 命令正常结束          | 命令退出码（信号 → 128+n） | 原样返回                             |
| `--timeout` 到点      | 124                        | `TimeoutError`（与现状一致）         |
| 网络栈/执行器启动失败 | 125                        | 启动失败错误（附执行器 stderr 尾部） |
| 用法错误              | 2                          | 内部错误                             |

- **超时**交给执行器处理（它在内部用 pidfd 终止，不会留下残留）。
- **用户取消（AbortSignal）**：TS 侧先关执行器进程的 stdin（执行器读到 EOF 走优雅停：内核清理 pid namespace → exit-fd HUP → slirp4netns 自行退出），短暂等待后若仍未退出再 `SIGTERM`（这是我们自己 spawn 的子进程，与现状同级风险），最后 `SIGKILL`。这条路径写进注释，说明为什么可以接受。
- 执行器**不**把 `--timeout` 与 abort 混为一谈：abort 由 TS 关闭 stdin 触发。

## 输出与诊断

- 命令的 stdout/stderr：原样转发（用户可见）。
- 执行器自身诊断（mihomo/slirp 日志、启动细节）：stderr 上带 `[netstack] ` 前缀；TS 侧据此分流到现有 `NetworkStackLog.holder` 诊断通道，默认不展示，`--verbose`/日志出口需要时给出。
- 运行期异常终止（执行器在命令结束前退出）：TS 侧把已收集的诊断与退出状态落盘（沿用 `writeFailureLog` 的目录与格式），命令失败时把路径附进错误信息与 `sandboxHint`——与「运行期失败诊断留档」requirement 一致。

## 二进制查找与分发

- 包内路径：`bin/native/linux-x64/sandbox` 与 `bin/native/linux-arm64/sandbox`，按 `process.arch` 选择。
- **直接放进包里**：不做 optionalDependencies 平台包、不做运行时下载/prebuild 安装脚本——这个包只装在 Linux 上，多平台机制只会带来额外复杂度。代价是包体积增加（每个二进制约 5MB，`-ldflags "-s -w"` 后更小）。
- 缺失或不可执行：抛明确错误（含期望路径、当前 `platform/arch`、"本平台不受支持"的判定），**不降级**到旧实现。
- 构建：`ci.yml` 与 `release.yaml` 用 `actions/setup-go` + `CGO_ENABLED=0 GOOS=linux GOARCH={amd64,arm64} go build -trimpath -ldflags "-s -w"`；本地用 `pnpm run build:native`（新增脚本，两个架构都构建）。
- 版本一致性：二进制与 TS 包同版本发布（同一 commit、同一次 `npm publish`），不做独立版本协商；执行器可以有一个 `version` 子命令用于排查，但不作为协议门槛。
- 最低内核：`pidfd_open` + `poll(pidfd)` 需要 Linux 5.3，README 与 change 里写明；启动时探测 `pidfd_open` 失败即明确报错（不再有"按 pid 兜底"的分支）。

## 测试策略

- 保持不动：配置/策略/审批相关测试（它们不依赖网络栈实现）；预览相关用例随功能删除。
- 改写：`bwrap-netstack-integration.test.ts` → 通过 TS 公开接口驱动原生执行器，覆盖 allowlist 放行/拒绝、超时终止、无残留进程；新增执行器级检查（`native/` 的 Go 单测或脚本）覆盖 pidfd 语义与 kill 路径。
- 迁移或删除：`bwrap-mihomo-config.test.ts`（配置生成搬到 Go，测试随之搬到 Go 侧；TS 侧保留"allowlist → 规则"的解析校验如果仍需要）。
- 新增：`package.json` 的二进制查找单测（存在/缺失两条路径）、退出码映射单测（124/125/信号）。
