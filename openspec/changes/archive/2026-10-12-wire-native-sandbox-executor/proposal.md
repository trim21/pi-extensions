# Proposal

## Why

`native/` 里的 Go 原型（PR #189）已验证：把"namespace + 网络栈 + 进程身份"这段从 JS 挪到原生实现，可以消掉 TS 版四个结构性妥协——node 顶 PID 1、`unshare` 包装进程、`nsenter` 进出、以及只能按 pid 发信号（TOCTOU）。现在把它接进真实路径。

接入的收益是具体的：

- 每条命令的进程链少两个（`unshare`、`nsenter`），命令直接跑在目标 netns 里；
- exit-fd 走 `ExtraFiles`，不再依赖 `holder.stdio[3]._handle.fd` 这类 Node 私有字段；
- 终止全部经 `pidfd_send_signal`（配合"未 reap 的子进程 pid 不会被复用"这条语义，不存在误伤无关进程的路径）；
- 过滤进程的就绪判定由执行器自己给出，不再耦合 mihomo 的日志文案；
- `holder.js` 这个 esbuild 产物、`build:holder` 脚本与它的回归测试一并消失。

## What Changes

- **TS 执行层改为驱动原生执行器**：`runInSandbox` 把执行计划序列化成 policy JSON，spawn `bin/native/<arch>/sandbox run --policy-base64 …`，转发 stdout/stderr、映射退出码（超时 124、启动失败 125）。
- **policy 是能力描述**：TS 侧给出挂载计划（`root` + 有序 `mounts`，路径已归一化，含 `PROTECTED_DIRS` 与工作区 `.git` 只读）、network（mode/allowlist/dnsServers）、`command`/`shell`/`cwd`/`env`/`uid`/`gid`/超时；bwrap 参数、namespace 与网络栈参数、mihomo 配置由执行器据此构造——bwrap 参数知识只在 `native/bwrap.go` 一处，避免两侧各懂一半。
- **删除 `--print-args` 预览**：预览里"网络栈相关"的部分（nsenter 前缀、holder pid）只有在真正起栈后才有真实值，预览只能输出占位符；而它的消费者只有 CLI 与自己的单测（Bash 工具不依赖）。随之删除 `previewSandboxCommand`、`invocationArgv`、`HOLDER_PID_PLACEHOLDER` 与相关用例；调试沙箱策略改用 `--verbose` 与诊断日志。
- **删除 TS 侧的网络栈实现**：`src/bwrap/network-stack.ts`、`src/bwrap/holder.ts`、产物 `src/bwrap/holder.js`、`core.ts` 里的 `createNetworkStack` / `resolveDnsServers` / `findMihomo` / `findSlirp4netns`（改为由 TS 传 DNS 与二进制路径）、`exec.ts` 里的 `nsenter` 前缀与进程 spawn 逻辑、`package.json` 的 `build:holder`。
- **二进制随包分发**：Go 交叉编译出**静态链接的 Linux 二进制**，直接放进包里（`bin/native/linux-x64/sandbox`、`bin/native/linux-arm64/sandbox`），`files` 增加该目录。这个包只在 Linux 上安装，因此不走 optionalDependencies 平台包 / 运行时下载那套机制。
- **CI 与发布**：`ci.yml` 增加 `go vet` / `go build`；`release.yaml` 增加 Go 工具链、交叉编译并把二进制打进包里，触发路径增加 `native/**`（否则改 Go 不触发发布）。
- **不保留旧路径**：二进制缺失或平台不支持时明确失败，不做"退回 JS 实现"的降级——两套实现并存必然漂移。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap-network`：
  - 「网络栈生命周期管理」：网络栈由原生执行器持有与清理，终止经 pidfd；删除"GC 兜底"一条（不再有需要调用方记得 stop 的 JS 侧对象），scenarios 随之改写。
  - 「就绪检测」：就绪语义不变，但就绪信号由执行器给出（不再依赖过滤进程的日志文案），egress 接口 fail fast 由执行器实现。
  - 「运行期失败诊断留档」：留档内容与时机不变（执行器异常终止时把诊断交给调用方、命令失败时呈现），实现位置从 TS 迁到"执行器输出 + TS 落盘"。

## Impact

- 代码：`src/bwrap/{sandbox.ts,exec.ts,core.ts,runtime.ts}`、删除 `src/bwrap/{network-stack.ts,holder.ts,holder.js}` 与预览相关代码（`previewSandboxCommand`、`invocationArgv`、`HOLDER_PID_PLACEHOLDER`、`bin/sandbox.ts --print-args`）、`native/`（policy 改为能力描述，`bwrap.go` 负责 argv 构造）。
- 配置与发布：`package.json`（`files`、scripts）、`.gitignore`（本地构建产物）、`.github/workflows/{ci,release}.yaml`。
- 测试：`test/bwrap*.test.ts` 中与网络栈实现绑定的部分（`bwrap-netstack-integration.test.ts` 改为驱动原生执行器；`bwrap-mihomo-config.test.ts` 随配置生成搬到 Go）、其余沙箱测试应保持不变（它们测的是策略，不测实现）；预览相关用例随功能一并删除。
- 行为兼容：对使用方（Bash 工具、`pnpm sandbox`）保持命令行语义、退出码、超时/取消语义与诊断出口不变；仅要求宿主是 Linux（原本 `network: limited` 也只支持 Linux）并且包内有对应架构的二进制。
