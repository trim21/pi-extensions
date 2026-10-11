# Design

## Context

gh 工具集当前由 `personalExtensions.codemodeOnlyTools` 决定是否交给 pi，配置默认空，所以 18 个工具都是"既交给 pi、又进 codemode"。codemode 侧解包 `structuredResult.value`（没有结构化结果时才退回拼 `content` 文本），因此文本渲染只服务直调路径。参见 proposal 的 Why。

## Goals / Non-Goals

- Goal：gh 工具的曝光方式由代码决定，编译期就排除"交给 pi"这个选项；工具只产出结构化数据。
- Non-Goal：不改变取数行为、参数、判定语义与等待时长；不新增配置字段；不改 codemode 沙箱本身。
- Non-Goal：`parseDiffStats` 这类"从原始文本解析出结构化数据"的函数不属于渲染层，保留。

## Decisions

**1. 注册入口用独立方法 `registerCodemodeOnly(definition)`，而不是给工具定义加字段、也不是新增配置字段。**
曝光方式是模块的结构性事实（gh 工具永远是脚本工具），不该让用户配置承担，也不该让定义上的布尔字段与配置路径相互覆盖。这个入口收的是一份更小的定义类型 `CodemodeToolDefinition`——只有 `name` / `label` / `description` / `parameters` / `structuredSchema` / `execute`，`execute` 直接返回 `StructuredResult`。没有 `AgentToolResult` 的位置，也没有"没有 `structuredSchema` 就退回普通注册"这个分支（配置路径保留它，因为配置是用户写的，静默移除工具比报错更糟）。

**2. 执行入口一分为二：`executeTool` 服务仍交给 pi 的工具，`executeCodemodeTool` 服务 codemode-only 工具。**
两类工具的结果契约不同（前者是 pi 的 `AgentToolResult`，后者是本仓库的 `StructuredResult`），让一个方法返回联合类型会把两边的调用方都拖进窄化分支。codemode 的 worker 只调后者，"没有结构化结果就退回拼文本"这个兜底也随之消失——准入条件本来就要求 `structuredSchema`。`executeTool` 遇到 codemode-only 的工具名返回明确的错误结果，避免调用方误用。

**3. 禁用复用 `disabledTools`，不新增 `disabledCodemodeTools`。**
语义一致（禁用 = 不注册），且总线的过滤链本来就在最前面判定，对两条注册路径都生效。新增字段只会让"某个环境禁用 gh 工具"多一种写法。

**4. 删掉载荷里的 `text` 字段，而不是把它留给脚本。**
脚本能拿到全部结构化字段，`text` 只是文本消费的镜像；保留它等于把渲染层的输出再搬进载荷，删了渲染器还得留一份生成它的代码。

**5. 连进度输出一起删。**
`wait-github-*` / `watch-github-run` 的进度行依赖 `onUpdate`，而这条路径上没有任何调用方会提供它：工具不再交给 pi（模型直调没了），codemode 的 `executeCodemodeTool` 也不转发内部工具的进度（codemode 的进度语义是"脚本 `text()` 出来的内容"，混入嵌套工具的进度会让输出来源不可知）。没有消费者的渲染代码留着只会腐烂，因此 `renderPrChecksList` / `renderRunStatus` / `checkDisplayName` 与它们的 `subject` 参数一并删除；等待与判定行为不变。

## Risks / Trade-offs

- [模型不能再直调，用户既有习惯失效] → README 与 skill `github-ci-logs` 改成 codemode 用法；工具的参数与返回类型仍出现在 `codemode` 的工具描述里。
- [脚本从 `value.text` 改为读结构化字段是破坏性变更] → 破坏面只在 codemode 脚本里，且配置默认从未把 gh 工具设成 codemode-only，实际存量脚本可能为零；迁移说明写进 README。
- [等待类工具在脚本里完全静默，用户看不到轮询进展] → 接受；脚本可以在调用前后用 `text()` 输出自己的进度行。
- [删渲染器时误删解析逻辑] → `parseDiffStats`、`normalizeRestList`、`mergeChecks` 等产出结构化数据的函数保留，只删"把数据拼成给人看的字符串"的部分；`test/gh-render.test.ts` 里对解析函数的用例保留。

## Migration Plan

破坏性变更，无自动迁移：更新 README、skill，脚本改为读结构化字段。回滚即还原代码，无数据面影响（唯一持久化产物是 CI 日志与 release 资产的缓存目录，路径不变）。
