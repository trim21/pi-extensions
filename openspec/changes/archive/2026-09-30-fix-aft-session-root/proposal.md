# Proposal

## Why

AFT 扩展在工厂创建时用 `process.cwd()` 作为项目根（`src/aft/index.ts`），既拿它读配置、也拿它建 bridge、还拿它当工具路径基准。当 pi 进程的启动目录与会话工作目录不一致时（例如在 `$HOME` 下启动 pi，会话开在某个项目目录），AFT 会把 `$HOME` 当成项目根：

- 引擎按「项目根 = 用户家目录」自动关闭 `search_index` / `semantic_search` / `callgraph_store`，整个会话里 `aft_search` 与调用图能力静默降级。
- `aft_outline` 的目录模式把**未解析的原始 target** 转发给引擎，由引擎按它自己的项目根解析，于是相对路径落到 `$HOME` 下并报 `directory not found: /home/<user>/src/foo`；文件模式因为转发的是已解析的绝对路径而不受影响。

同一份 cwd 被当作三处基准，任一处用错都会同时污染另外两处。

## What Changes

- AFT 的项目根改用**会话工作目录**（`session_start` 的 `ctx.cwd`），不再用扩展加载期的 `process.cwd()`；bridge 创建、工具取 bridge、project tier 配置读取统一以它为准。
- 扩展自身读取的用户级配置路径不再依赖任何目录（`resolveCortexKitUserConfigPath()` 无参），语义搜索开关的判定行为不变。
- `aft_outline` 不再把原始相对路径转发给引擎：文件与目录两种模式都转发本地解析好的绝对路径。
- 工具的路径基准不再由工具上下文另存一份，改为直接使用 bridge 状态记录的项目根，消除双份事实来源。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `aft`: 新增「项目根取自会话工作目录」要求，并补充「相对路径在扩展侧解析后转发」的场景。

## Impact

- 代码：`src/aft/index.ts`（项目根来源与工具上下文构造）、`src/aft/tools.ts`（`AftToolContext` 去 cwd、outline 参数转发）。
- 行为：用户在非项目目录启动 pi 时，AFT 不再把家目录当项目根；语义搜索与调用图的自动降级消失，相对路径的目录 outline 恢复可用。
- 兼容性：normal 情况（pi 启动目录 == 会话工作目录）行为不变。bridge 进程池按项目根索引，同一会话工作目录仍然跨会话复用同一进程；同一进程内切换会话到不同工作目录会各自持有自己的 bridge（`getBridge(projectRoot)` 本就如此）。
- 测试：`test/aft-index.test.ts` 的 `createAftState` 断言改为会话 cwd；新增针对目录模式相对路径的回归测试。
