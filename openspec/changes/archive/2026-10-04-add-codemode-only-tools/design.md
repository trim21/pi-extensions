# Design

## Context

见 `proposal.md` - Why。当前形态（可改的约束）：

- 工具注册只有一条路径：`bus.register(def)` → `pi.registerTool(def)` → 同时进入模型可见列表与总线的 `registered` 表（`src/lib/tool-bus.ts`）。
- `codemode` 的脚本可调用集合来自 `bus.list()`，过滤条件是「声明了 `structuredSchema`」∩ 当前 active 列表（`src/codemode/tool.ts` 的 `collectTools`）。
- 工具可用性由 `personalExtensions` 配置在 `session_start` 时求值一次（`src/lib/tools-config.ts` + `src/lib/tool-registration.ts`）。
- 本仓库锁的 `@earendil-works/pi-coding-agent` 是 0.87.1，没有 `exposure` / `defaultActive` / `ctx.executeTool` 那套编排 API；本仓库的 codemode 也是经总线直调工具、不走 pi 的 loadout。

## Goals / Non-Goals

**Goals:**

- 用一个配置字段把指定工具从模型可见列表移入 `codemode`，不改任何工具模块的实现。
- 保持「禁用 = 完全不注册」与「有结构化输出才可脚本调用」两条既有规则不变。
- 不引入对 pi 版本的依赖。

**Non-Goals:**

- 不做「全部工具只经 codemode」的全局模式。
- 不给没有 `structuredSchema` 的工具补 schema。
- 不修子代理里 codemode 可达性的既有缺口。
- 不接入 pi 原生 `exposure`（留待将来 pi 升级后收敛）。

## Decisions

### 用「不交给 `pi.registerTool`」表达 codemode-only

命中配置的工具照常 `bus.register`，但只写进总线内部的 `registered` 表，跳过 `pi.registerTool`。这样 pi 侧完全没有这个工具：不进模型可见列表、不进 active、不发 `promptSnippet`，也不受 `--tools` / `defaultTools` 影响。

备选：注册后从 active 列表移除（`setActiveTools`）。放弃——`tool-registration` spec 明确禁止通过调整 active 列表改变可用性，且 active 列表会被 pi 在 `/reload`、loadout 变化时重算，移除不可靠。

### 配置字段 `codemodeOnlyTools`，而不是工具定义处声明

条目形状与匹配规则完全复用 `disabledTools` / `enabledTools`：字符串或 `{ tools, models? }`，minimatch，模型名双写法。理由：这是选择而非工具固有属性，配置层是唯一求值点，新增/调整不用动工具模块，也天然支持按模型区分。首批 gh-readonly 全部 18 个写进用户 settings.json。

备选：在每个 `bus.register` 调用处加 `codemodeOnly` 标记。放弃——要改 18 个工具文件，且无法按模型或按用户偏好调整；但它可作为将来「工具固有属性」的补充，本次不做。

### 总线上保留 `codemodeOnly` 标记，`codemode` 据此放行

`RegisteredToolDefinition` 增加 `codemodeOnly?: boolean`；`ToolBusOptions` 增加 `isCodemodeOnly(name)`（与既有 `isDisabled` 对称）。`collectTools` 的过滤条件从 `allowed === undefined || allowed.has(name)` 改为 `d.codemodeOnly === true || allowed === undefined || allowed.has(name)`。直接工具仍与 active 求交，codemode-only 工具不受影响（它本来就不在 active 列表里）。

### schema 门控：只对声明了 `structuredSchema` 的工具生效

`codemodeOnly` 只在工具声明的 `structuredSchema !== undefined` 时成立——判据与 `collectTools` 的准入门槛保持同一个（两处都按 `structuredSchema !== undefined`，不要各自演化）。命中配置但没有 schema 的工具照常走正常注册（交给 pi），并记一条诊断。

为什么：codemode-only 的语义是「搬进 codemode」。没有 schema 的工具根本进不了 codemode（`collectTools` 会先按 schema 过滤），若仍按 codemode-only 处理，结果是从模型面前与脚本两侧同时消失——等于用 `codemodeOnlyTools` 做 `disabledTools` 的事，而且是静默的。`Read` / `Edit` / `Write` / `Glob` / `Grep` / talk / 会话工具 / `spawn-agent` / `codemode` 自己都没有 schema，一个 `["*"]` 或写错的模式就会把它们一起隐藏。门控让 codemode-only 永远只做「搬家」，删除的语义留给 `disabledTools`。

诊断沿用既有的会话期警告通道（与 `registration.unmatchedPatterns()` 一起在 `session_start` 上报），文案指明工具无结构化输出、保持直接可用。

### 优先级与边界

- `disabledTools` 优先：先判禁用，再判 codemode-only。禁用者连总线都不进。
- schema 门控其次：命中 codemode-only 但没有 `structuredSchema` 的工具照常直接注册，并产生诊断。
- `unmatchedPatterns` 的口径沿用现有实现，把 `codemodeOnlyTools` 并入统计字段。
- 不修改 pi 的 active 列表。

## Risks / Trade-offs

- **[codemode-only 工具在子代理里可能不可达]** 子代理是否注册 codemode 本身仍有既有缺口（只有声明了对应工具单元才会进子代理总线）→ 本次不修，按现状；配置在子代理侧仍一致生效。
- **[配置意图被部分忽略]** 命中 codemode-only 但没有 schema 的工具被留在直接注册状态，配置字面意思未完全执行 → 由会话期警告显式说明，不静默；想真正移除用 `disabledTools`。
- **[codemode 描述变长]** 工具声明从「模型可见列表」移到「codemode 描述」，总 token 不增反减（少了一份重复声明），但 codemode 单条描述会更大 → 无需处理。

## Migration Plan

无状态迁移。回滚 = 从 settings.json 删掉 `codemodeOnlyTools`（或删掉字段实现），工具恢复直接可见。
