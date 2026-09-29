# Proposal

## Why

模型写一段 JavaScript 编排其他工具（codemode）是很划算的能力：脚本可以并行发起多次调用、在本地过滤大结果，只有脚本输出进入上下文。pi 0.99 起内置了它，但本项目依赖的 pi 版本没有；而内置实现的隔离边界只有 QuickJS VM 一层——脚本所在的 worker 与 pi 共享文件系统与网络，且模型把写操作藏进脚本时用户看不到逐次的调用。

本仓库的工具集与隔离、审批层都在自己手里：`src/bwrap/` 是沙箱，`src/lib/write-guard.ts` 与 `BwrapRuntime` 的提权审批是写在工作具体实现里的显式调用（`files.ts:373`、`rename-tool.ts:201`、bwrap runtime 的 `approveFullAccess`），`pi.registerTool` / `pi.appendEntry` / `constrainedSampling` 都是本仓库 peerDependency 下限（0.84.1）就有的 API。因此可以做一个**不需要升级 pi** 的 codemode：脚本在 bwrap 内执行，嵌套调用经本仓库的 tool bus（`unify-tool-registration`）直接执行已注册的工具，写类调用逐次确认。

**前置变更**：本变更依赖 `unify-tool-registration`——它把工具注册收敛到单一入口并提供 tool bus（注册 / 枚举 / `executeTool`）。codemode 注册在同一个入口内，用总线的 `executeTool` 调用工具，因此不需要 pi 的 `ctx.executeTool`。

## What Changes

- 新增 `codemode` 工具，注册在统一入口内（`unify-tool-registration` 的单一入口）。在提供内置 codemode 的 pi 版本上，注册同名工具即替换内置。
- 脚本在 **bwrap 内的一次性子进程**里执行：根只读、断网、遮蔽 workspace 与 agent 敏感路径；QuickJS wasm 在子进程内实例化，脚本与 pi 之间只用 stdio 上的 NDJSON 协议通信。
- 脚本可调用工具即 tool bus 上实际注册的全部工具（由 `personalExtensions` 配置与当前启用状态决定），由 codemode 经总线的 `executeTool` 执行——工具内部的写入审批与 Bash 提权审批照常生效。
- 只读集合（`Read` / `Glob` / `Grep`，opencode 工具集下为 `read` / `glob` / `grep`）之外，每次嵌套调用都要用户单独确认；无 UI 时拒绝，被拒绝的调用以错误回到脚本。
- 脚本接口与 pi 的 codemode 保持一致：`tools.*`、`ALL_TOOLS`、`text` / `image` / `exit` / `console` / `store` / `load`、顶层 `await` 与 `return`、首行 `// @options:`。
- **不提升 peerDependencies**：不使用 `ctx.executeTool()` / `exposure` / `prepareLoadout`——这些是 pi 0.99 才有的 API，本实现不需要它们。
- 新增运行期依赖 `@earendil-works/pi-codemode`（QuickJS 沙箱，除 `quickjs-wasi` 外无依赖，与 pi 版本无关）。

## Capabilities

### New Capabilities

- `codemode`: codemode 工具的脚本执行隔离边界，与嵌套调用的确认行为。

### Modified Capabilities

无。bwrap 侧既有 requirement 描述的是 bash 命令的沙箱模式，本变更不改动它——codemode 用自己固定的沙箱配置，不复用 `/bwrap-fs-*` / `/bwrap-network-*` 的运行时切换。

## Impact

- 代码：新增 `src/codemode/`（工具定义、子进程 helper、协议）；在 `unify-tool-registration` 的 `src/index.ts` 里接线注册 codemode。
- 依赖：新增 `@earendil-works/pi-codemode`；pi 相关依赖与 peerDependencies 不变。
- 构建：helper 需要 esbuild 构建产物（沿用 `src/bwrap/holder.ts` → `holder.js` 的先例与 `build:holder` 脚本模式）。
- 测试：`test/codemode.test.ts`（协议编解码、需确认判定、只读集合、工具来源、超时与进程组终止），沙箱路径参照 `test/bwrap-sandbox.test.ts`。
- 已知限制（写进 design 与文档）：嵌套调用经我们自己的工具总线执行，因此**其他扩展注册的 `tool_call` / `tool_result` 钩子不会触发**（本仓库的审批在工具实现内部，不受影响）；脚本只能调用本仓库注册的工具，pi 内置工具与第三方扩展的工具不可达。
- 用户可见行为：codemode 的脚本进程被 bwrap 隔离；脚本里的写类调用逐次弹确认；两套文件 IO 工具集（由 `personalExtensions.fileIo` 选择）都可作为脚本的可调用工具，只读集合按各自命名匹配。
