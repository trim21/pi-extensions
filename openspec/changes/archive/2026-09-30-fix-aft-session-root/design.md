# Design

## Context

`createAftTools(pi)` 在扩展工厂创建时求一次 `process.cwd()`，此后这个值被复用为三件事的基准：用户级配置路径（`resolveCortexKitConfigPaths`）、bridge 状态的项目根（`createAftState` → `createAftTransportPool`）、工具上下文里的路径基准（`AftToolContext.cwd` → `pool.getBridge(cwd)`）。

`createAftTools` 只拿得到 `ExtensionAPI`，拿不到会话上下文；会话工作目录只有 `session_start` 的 `ExtensionContext.cwd` 才有。pi 的扩展工厂按入口各自建一份模块图，扩展加载期的 `process.cwd()` 就是 pi 进程的启动目录，与会话工作目录可以不同。

bridge 侧 API 本身已经按项目根索引（`pool.getBridge(projectRoot)`、`AftTransportPool` 每根一个常驻进程），所以项目根只是一个必须传对的入参，不需要新的缓存或生命周期机制。

## Goals / Non-Goals

**Goals:**

- 项目根唯一且等于会话工作目录，三处基准合并为一处。
- 相对路径不再依赖引擎侧推导：扩展侧解析后转发。

**Non-Goals:**

- 不改 bridge 进程池的缓存与释放策略（仍由 `state` 持有、session 生命周期释放）。
- 不改引擎对「项目根 = 用户家目录」时的自动降级逻辑，也不为家目录做特殊处理。
- 不改语义搜索开关的判定口径（仍只看用户级配置）。

## Decisions

### 项目根取自 `session_start` 的 `ctx.cwd`

`registerForSession(bus, ctx)` 已经拿得到会话 ctx，项目根就在那里求值：`createAftState(ctx.cwd, ...)`。

替代方案：在 `registerForSession` 里读 `process.cwd()` 的替代品（如 `ctx.sessionManager` 的目录信息）。否决——`ctx.cwd` 就是宿主给出的会话工作目录，与其它工具（Bash 的 workdir、文件工具的路径解析基准）同源。

### `AftToolContext` 不再持有 cwd

工具取 bridge 时改用 bridge 状态自己记录的项目根（`getState().pool.projectRoot`），而不是另存一份 cwd。这样「用来建 bridge 的根」与「用来取 bridge 的根」在类型上不可能分叉。

替代方案 1：保留 `AftToolContext.cwd`，在 `registerForSession` 里用 `ctx.cwd` 构造工具上下文。可行，但保留了两个可能不一致的来源（工具上下文的 cwd vs 状态里的 projectRoot）。

替代方案 2：工具执行时改用 per-call 的 `extCtx.cwd` 取 bridge。否决——工具执行上下文与 `session_start` 上下文在正常路径下同源，但一旦不一致就会向池索取未创建的根，失败模式比现状更难诊断。

### 扩展自身的用户级配置路径不再依赖任何目录

`loadAftConfig` 只读用户级配置，直接使用无参的 `resolveCortexKitUserConfigPath()`。项目级配置（`aft.jsonc` 的 project tier）由 bridge 侧按项目根读取（`readConfigTiers`），因此它随项目根自动正确。

替代方案：把 `loadAftConfig` 也挪到 `registerForSession` 里按会话 cwd 读一次。否决——扩展的门控开关按既有 spec 只由用户级决定，挪动只是把不依赖目录的读取换个时机，没有行为收益。

### 目录模式同样转发解析后的绝对路径

`aft_outline` 原先把 `filesMode ? target : resolved` 作为参数，目录模式因此把相对路径交给引擎解析。改为两种模式都转发 `resolved`。

替代方案：保留相对路径，只把项目根修对。否决——那要求引擎的项目根与会话工作目录永远一致；而把路径解析留在扩展侧（已有 `resolvePathArg` 与 `extCtx.cwd`）本就与文件模式一致，也让引擎侧行为不受项目根推导影响。

## Risks / Trade-offs

[同一进程内多个会话工作目录不同 → 各自持有自己的 bridge 进程，常驻进程数增加] → 进程池按根索引是既有设计（`getBridge(projectRoot)`），旧的 state 在 `session_shutdown` 释放；不新增机制，只是不再错误地把所有会话折叠到同一个根。

[项目级 `aft.jsonc` 的读取结果随会话工作目录变化] → 这正是预期：项目级配置本就属于项目目录。

[回归风险：`createAftState` 的入参从 `process.cwd()` 变为会话 cwd] → 由 `test/aft-index.test.ts` 的断言覆盖（会话 cwd 与进程 cwd 用不同的假值），目录模式相对路径由新增回归测试覆盖。
