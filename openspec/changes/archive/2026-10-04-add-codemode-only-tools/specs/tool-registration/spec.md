# Spec Delta

## MODIFIED Requirements

### Requirement: 工具总线

注册层 MUST 实现一个工具总线，提供：注册（按配置过滤后登记定义，并决定是否交给 pi 注册）、枚举（列出本次实际登记的工具定义）、按名查询、以及 `executeTool(name, args, options)`。命中 codemode-only 配置且声明了 `structuredSchema` 的工具 MUST 只登记进总线、MUST NOT 交给 pi 注册；命中 codemode-only 但没有 `structuredSchema` 的工具 MUST 照常直接注册，MUST NOT 被隐藏。其余通过过滤的工具 MUST 照常交给 pi 注册。枚举 MUST 同时包含为 pi 注册的工具与 codemode-only 工具。`executeTool` MUST 在调用前用工具自身的参数 schema 校验参数，MUST 把校验失败与工具抛出的异常归一化成错误结果返回，MUST NOT 把异常抛给调用方。总线 MUST 由工厂创建、状态由闭包持有，MUST NOT 使用模块级可变状态。工具总线 MUST 只包含本次实际登记（未命中无条件禁用、属于选中工具集）的工具。

#### Scenario: 按名执行已注册工具

- **WHEN** 同入口内的模块用 `executeTool` 调用某个已登记工具并传入合法参数
- **THEN** 得到该工具的执行结果，等价于模型直接调用它

#### Scenario: 参数不合法

- **WHEN** `executeTool` 收到的参数不符合该工具的 schema
- **THEN** 返回错误结果（含校验信息），不执行工具，也不抛异常

#### Scenario: 工具执行抛错

- **WHEN** 工具执行过程中抛出异常
- **THEN** 返回错误结果（含错误信息），不把异常抛给调用方

#### Scenario: 查询不到的工具

- **WHEN** `executeTool` 或按名查询收到一个未登记（或已被禁用）的工具名
- **THEN** 返回明确的「工具不可用」错误结果，不执行任何东西

#### Scenario: codemode-only 工具只登记进总线

- **WHEN** 一个声明了 `structuredSchema` 的工具命中 codemode-only 配置
- **THEN** 它出现在总线的枚举与按名查询里，`executeTool` 能执行它，但它 MUST NOT 被交给 pi 注册

#### Scenario: 没有结构化输出的工具保持直接注册

- **WHEN** 一个没有声明 `structuredSchema` 的工具（例如 `Read`）命中 codemode-only 配置
- **THEN** 它照常交给 pi 注册、仍直接可用，并产生一条指明它没有结构化输出、未按 codemode-only 处理的警告

### Requirement: 启用配置

配置 MUST 读取 `~/.pi/agent/settings.json` 的 `personalExtensions` section，包含：

- `fileIo`：兜底的文件 IO 工具集，取值 `"claude-code"` 或 `"opencode"`，缺省 `"claude-code"`。
- `fileIoByModel`：可选数组，条目为 `{ models: string[], fileIo: "claude-code" | "opencode" }`，按顺序取第一条模型命中的条目覆盖 `fileIo`。
- `disabledTools` / `enabledTools` / `codemodeOnlyTools`：可选数组，条目 MUST 是工具名模式字符串，或 `{ tools: string[], models?: string[] }`。工具名与模型名都用通配模式匹配；工具名按名称整体匹配；模型名 MUST 同时尝试匹配当前模型的 `model id` 与 `provider/model` 两种写法。

工具生效规则 = 命中 `disabledTools` 且未命中 `enabledTools`；带 `models` 的条目只在当前模型命中时才参与判定。工具同时命中 `codemodeOnlyTools`、未被禁用、且声明了 `structuredSchema` 时，MUST 按 codemode-only 注册；命中 `codemodeOnlyTools` 但没有 `structuredSchema` 时 MUST 照常直接注册并产生警告。配置缺失时 MUST 使用默认值继续工作；出现非法条目，或某个工具名模式匹配不到任何工具（含被规则禁用的工具）时，MUST 产生可诊断的警告，且 MUST NOT 影响其余配置项生效。

#### Scenario: 未配置时使用默认值

- **WHEN** settings.json 没有 `personalExtensions` section
- **THEN** 注册 claude-code 那套文件 IO 工具集，不额外禁用任何工具，也不启用任何 codemode-only 工具

#### Scenario: 通配匹配

- **WHEN** `disabledTools` 含 `"talk-*"`
- **THEN** 所有以 `talk-` 开头的工具都被命中，其他工具不受影响

#### Scenario: codemode-only 按模型匹配

- **WHEN** `codemodeOnlyTools` 含 `{ "tools": ["read-github-*"], "models": ["gpt-*"] }`
- **THEN** 仅在匹配 `gpt-*` 的会话里这些工具被注册为 codemode-only，其他模型下不受影响

#### Scenario: 按模型选择工具集

- **WHEN** `fileIo` 为 `claude-code` 且 `fileIoByModel` 含 `{ "models": ["glm-*"], "fileIo": "opencode" }`
- **THEN** 匹配 `glm-*` 的模型注册 opencode 那套工具（`bash` / `read` / `write` / `edit` …），其他模型注册 claude-code 那套（`Bash` / `Read` / `Write` / `Edit` …）

#### Scenario: 按模型启用

- **WHEN** `disabledTools` 含 `{ "tools": ["web_*"], "models": ["*"] }`，且 `enabledTools` 含 `{ "tools": ["web_search"], "models": ["glm-*"] }`
- **THEN** 只有在匹配 `glm-*` 的模型下 `web_search` 可用，其他模型下 `web_search` 不可用

#### Scenario: 非法取值给出警告

- **WHEN** `fileIo` 不是 `claude-code` / `opencode`，或某条目既不是字符串也不是 `{ tools, models }`
- **THEN** 该条被忽略，其余配置照常生效，并给出指明该字段与取值的警告

#### Scenario: 未知工具名给出警告

- **WHEN** 某个工具名模式匹配不到任何工具（含被规则禁用、因而没有注册的工具）
- **THEN** 该模式被忽略，其余规则照常生效，并给出指明该模式的警告

## ADDED Requirements

### Requirement: codemode-only 工具

命中 `codemodeOnlyTools`、未被禁用、且声明了 `structuredSchema` 的工具 MUST 以 codemode-only 形式注册：登记进工具总线，但 MUST NOT 交给 pi 注册。因此它 MUST NOT 出现在模型可见的工具清单与 active 工具列表里，也 MUST NOT 产生面向模型的 `promptSnippet` / `promptGuidelines`；模型仍可在 `codemode` 的工具描述里看到它的参数与返回类型声明。命中 `codemodeOnlyTools` 但没有声明 `structuredSchema` 的工具进不了 codemode，MUST NOT 被当作 codemode-only 处理——它 MUST 照常直接注册，并 MUST 产生一条指明其无结构化输出、保持直接可用的警告，避免配置意外把工具从模型面前移除。优先级是：`disabledTools` 更高——同时命中禁用与 codemode-only 时按禁用处理，既不交给 pi 也不登记进总线；其次是 schema 门控。扩展 MUST NOT 通过调整 pi 的 active 工具列表来实现 codemode-only。

#### Scenario: 不进模型可见工具清单

- **WHEN** 某工具被配置为 codemode-only
- **THEN** 该工具不出现在模型可见的工具清单与 active 列表里

#### Scenario: 禁用优先于 codemode-only

- **WHEN** 某工具同时命中 `disabledTools` 与 `codemodeOnlyTools`
- **THEN** 该工具不被注册：既不可由模型直接调用，也不在总线上

#### Scenario: 没有结构化输出的工具忽略 codemode-only

- **WHEN** 某工具命中 `codemodeOnlyTools` 但没有声明 `structuredSchema`
- **THEN** 它照常直接注册、模型仍可直接调用，且有一条说明它没有结构化输出、未按 codemode-only 处理的警告

#### Scenario: 不调整 active 列表

- **WHEN** 注册一个 codemode-only 工具
- **THEN** 扩展不调用 pi 的 active 工具设置接口，其他来源对 active 列表的选择不受影响
