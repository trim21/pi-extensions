# Design

## Context

现状：两套文件 IO 工具集都由工厂创建（`createClaudeCodeFileTools` / `createOpencodeFileTools`），工厂内部 `createReadsState()` 持有已读记账，注册的 Read/Edit/Write 通过 `recordRead` / `requireCurrentRead` / `requireUnchangedRead`（`src/lib/file-reads.ts`）维护它，会话启动与树内跳转时用 `restoreReads` 从历史工具结果重放。`ReadsState` 同时被注入 `codemode`，供脚本 `fs.read` / `fs.write` 做 stale 保护。

配置侧：`personalExtensions` 由 `src/lib/tools-config.ts` 一次性解析成 `ToolsConfig`，入口在创建 `createToolRegistration(pi)` 时拿到它；主入口（`src/index.ts`）与子代理（`src/spawn-agent.ts` 的 `subagentToolsExtension`）都在创建工具集时选工具集并注入共享服务。`fileIo` 的职责只是选择哪一套工具集，两套都完整注册。

约束：配置解析沿用现有「非法条目告警但不影响其余配置」的策略；工具集工厂必须仍能按路径独立加载（默认导出），不能要求调用方一定有入口实例。

## Goals / Non-Goals

**Goals:**

- 一个布尔开关关掉文件 IO 工具集上的 read-before-write 记账，主入口与子代理一致生效。
- 关闭后工具集合、命名、工具集选择、写保护审批完全不变。
- 默认行为零变化。

**Non-Goals:**

- 不改 `codemode` 脚本文件原语自身的记账与校验规则。
- 不做按模型的开关覆盖（`fileIoByModel` 仍然只选工具集）。
- 不改 `write-guard` 的审批行为、不改 `file-reads` 模块本身。

## Decisions

**1. 新增顶层布尔 key `fileIoReadTracking`，而不是扩展 `fileIo` 的取值或结构。**

- 选它：`fileIo` 表达「用哪套 toolset」，在它上面加 `false` 会把「选择」和「关闭某一层行为」揉在一起，且 `fileIoByModel` 的逐条覆盖语义会跟着变形；新 key 只多一个解析分支。
- 替代方案：`fileIo: false`（选择与开关混淆）；`fileIo: { toolset, readTracking }`（破坏现有字符串配置的兼容性）。

**2. 开关经工具集工厂的选项注入，不在工厂内部读配置。**

- 选它：入口已经持有解析后的 `ToolsConfig`（含告警聚合），工厂只接收 `readTracking?: boolean`，缺省 `true`。这样工厂仍然可独立加载，不在两个工厂里重复读 `settings.json`、也不重复产出告警。
- 替代方案：工厂内部 `readToolsConfig()`（重复 IO 与告警、独立加载时行为不显式）；把开关塞进 `ReadsState`（记账原语不该知道配置来源）。

**3. 关闭时逐点禁用，而不是换一套 reads 实现。**

- Read/read 与 Edit/Write 不调用 `recordRead`，工具结果不带 `details.reads`；Edit/Write 跳过 `requireCurrentRead` / `requireUnchangedRead`；LSP rename 的 `recordReads` 回调退化为空操作；`restoreReads` 直接返回。
- `ReadsState` 仍然创建并照旧注入 `codemode`，脚本原语的记账与 stale 校验因此不受影响（它们自己调用 `recordRead` / `requireCurrentRead`）。
- 选它：改动点集中在几处调用，`file-reads.ts` 保持纯粹；关闭时不会有「记了但不用」的隐藏状态。

**4. 配置解析收成整段 schema，默认值写在 schema 上。**

- `personalExtensions` 只用一份 `toolsConfigSchema` 描述：字段都不带 `Type.Optional`，缺省值用 schema 上的 `default` 声明；解析时先 `Value.Default` 补齐再 `parseWithSchema` 校验，所以解析结果每个字段都确定有值，`toToolsConfig` 只做归一化，不再散落 `?? 默认值`。
- 容错语义保留：整段解析失败时退到逐字段 / 逐条目解析（单条非法只丢这一条并告警），其余配置照常生效——这是 `tool-registration` 的既有要求，schema 本身表达不了「丢掉一条继续」。
- 替代方案：整段 `Value.Parse` 失败就整体回退默认值（一处拼写错误会让所有工具规则失效，不可接受）；逐字段手写类型判断（原来那样，形状散落在多处）。

**5. 默认导出的独立入口也读同一份配置。**

- `createClaudeCodeFileTools` / `createOpencodeFileTools` 的默认导出本来就自建 `createToolRegistration(pi)`，用它拿到的 `config.fileIoReadTracking` 传给工厂，保证 `-e` 加载与聚合入口行为一致。

## Risks / Trade-offs

- [关闭记账后 `codemode` 的脚本记账不再跨会话回放] → 因为 `restoreReads` 不再重放，而 `codemode` 的 `details.reads` 正是经它恢复的：resume / fork 后脚本要重新 `fs.read` 才能 `fs.write`。这是「完全关掉记账」的直接后果，在 `tool-registration` 的已读记账要求里写明；若以后需要可以只回放 `codemode` 条目。
- [误配 `false` 会失去防呆] → 这是开关的用途本身；缺省 `true` 保证默认不踩坑，配置告警只针对非法取值，不针对 `false`。
- [两套工具集各有一份实现，容易漏改一处] → 任务里把 claude-code 与 opencode 两条路径、主入口与子代理两条接线、以及各自的测试分开列。
