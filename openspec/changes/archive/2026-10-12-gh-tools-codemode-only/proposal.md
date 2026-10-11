# gh 工具只作为 codemode 工具

## Why

gh 的 18 个工具现在是「双曝光」：既能被模型直调，也能被 codemode 脚本调用。为了让直调路径有东西可读，每个工具都渲染了一份人类可读文本（`src/gh/render.ts` 的渲染器、`renderHits`、结构化载荷里的 `text` 字段、`details.pendant`、2000 行 / 50KB 截断）。而 codemode 脚本从来不看这些：它优先解包 `structuredResult.value`，只有工具没有结构化结果时才退回拼文本。

是否交给 pi 由用户配置 `codemodeOnlyTools` 决定（默认空），所以这层「为一个不存在的读者渲染文本」一直留着，还让每个工具的返回类型、schema 与测试都拖着两份数据。

结论：gh 工具只应作为 codemode 工具存在，曝光方式是代码决定的，不是配置决定的。要 GitHub 数据就写脚本，工具从对象到对象。

## What Changes

- **BREAKING**：`ToolBus` 新增 `registerCodemodeOnly(definition)`。它收「只会从 codemode 调用」的工具定义：参数类型要求 `structuredSchema`，因此不存在「没有结构化输出」的分支；执行时先过 `disabledTools`，未禁用则标 `codemodeOnly: true` 登记进总线，不交给 pi。它是配置路径之外的、代码层面的固定曝光方式。gh 的 18 个工具全部改用它注册。
- **BREAKING**：这条路径的工具结果契约是结构化结果 `{ ok: true; value } | { ok: false; error }`，不再是 pi 的 `AgentToolResult`——没有 `content` 数组、没有 `details`。它们是脚本工具，不存在「模型读到的文本」这个位置；总线为这条路径提供独立的执行入口（`executeCodemodeTool`），codemode 的脚本调用直接拿到 `value` 或错误。工具抛异常与参数校验失败都归一成 `{ ok: false, error }`。
- **BREAKING**：模型不能再直调任何 gh 工具（它们不出现在模型可见工具清单里，也不产生 `promptSnippet` / `promptGuidelines`）；脚本里仍按名调用，参数与返回类型照旧在 codemode 的工具描述里可见。
- **配置过滤照旧**：`disabledTools`（可带 `models`）在注册最前面判定，对新 API 同样生效——某些环境 / 模型下禁用 gh 工具就是不注册，脚本里也调不到。`codemodeOnlyTools` 保留为「按配置把普通工具转成 codemode-only」的通用能力。
- **BREAKING**：删除 gh 的文本渲染层——`src/gh/render.ts` 的渲染函数（解析出结构化数据、本身不是渲染的部分保留，如 `parseDiffStats`）、`src/lib/github.ts` 的 `renderHits`、结构化载荷里的 `text` 字段、`details.pendant` / `details.truncated`、文本截断、`withPendant` / `subtitlePendant` / `toToolResult` / `toToolResultJson`。
- **进度输出随之删除**：`wait-github-*` / `watch-github-run` 的 `onUpdate` 进度行与「Watching ...」文本没有任何调用方（codemode 不转发内部工具的进度，工具也不再交给 pi），整套进度渲染（`renderPrChecksList` / `renderRunStatus` / `checkDisplayName`）与其 `subject` 参数一并删除。等待与判定行为不变。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `gh-readonly`: 工具曝光方式改为只经 codemode（模型不可直调）；工具结果契约改为结构化结果（不再有 `content` / `details`）；删除「文本与结构化载荷同源」的输出契约、输出截断约定与文本渲染约定。
- `tool-registration`: 工具总线新增代码层面的 codemode-only 注册与执行路径，与配置驱动的 `codemodeOnlyTools` 并存；这两类工具的结果契约只有结构化结果。禁用优先级与「不调整 active 列表」的约束不变。
- `wait-github-pr-checks`: 不再有进度流式输出（没有任何 `onUpdate` 调用方）；检查名的展示约定改为载荷里 `name` / `event` 两个独立字段。
- `wait-github-commit-checks`: 同上——等待核心复用 `wait-github-pr-checks`，报告标题不复存在。

## Impact

- `src/lib/tool-bus.ts`：新增 `CodemodeToolDefinition` / `defineCodemodeTool`、`registerCodemodeOnly`、`executeCodemodeTool`（含 `codemodeOnly` 标记与禁用过滤）；`executeTool` 只服务仍交给 pi 的工具。
- `src/codemode/tool.ts`：脚本调用改走 `executeCodemodeTool`，删除「没有 structuredResult 就退回拼文本」的分支。
- `src/gh/`：18 个工具文件改注册入口、`execute` 只返回结构化结果；`base.ts` 去掉文本构造、pendant、截断与进度渲染；`render.ts` 只留解析类函数（或并入他处）；`schemas.ts` 去掉 7 处 `text` 字段。
- `src/lib/github.ts`：去掉 `renderHits`（`SearchHit` 与归一化保留）。
- 测试：`test/gh-*.test.ts` 里断言工具文本的用例改为断言结构化结果；`test/tool-bus.test.ts` 补 codemode-only 注册与执行路径（不进 pi、被 `disabledTools` 禁用、`executeTool` 不再服务它们）；删 `test/gh-render.test.ts` 中纯渲染部分。
- 文档：`README.md`、skill `src/skills/github-ci-logs/SKILL.md`（改成 codemode 用法）。
- 不涉及子代理：`ToolUnit` 表里本来就没有 gh 工具。
