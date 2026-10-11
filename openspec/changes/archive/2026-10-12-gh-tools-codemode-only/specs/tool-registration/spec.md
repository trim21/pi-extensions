# Spec Delta

## MODIFIED Requirements

### Requirement: 工具总线

注册层 MUST 实现一个工具总线，提供：注册（按配置过滤后登记定义，并决定是否交给 pi 注册）、codemode-only 专用注册（登记一个永不交给 pi 的脚本工具）、codemode-only 执行入口、枚举（列出本次实际登记的工具定义）、按名查询、以及 `executeTool(name, args, options)`。经 codemode-only 路径注册的工具 MUST 以结构化结果作为结果：成功是 `{ ok: true; value }`（`value` 与该工具声明的 `structuredSchema` 匹配），结构化失败是 `{ ok: false; error }`；它的定义 MUST NOT 要求 pi 的 `AgentToolResult`（没有 `content` / `details`）。`executeTool` MUST 只服务交给 pi 的工具，收到 codemode-only 的工具名时 MUST 返回明确的错误结果。codemode-only 执行入口 MUST 能执行总线上的任意工具：脚本定义（`execute` 直接返回结构化结果）原样复核后返回，普通定义取其 `structuredResult`（工具结果里没有结构化结果时给 `{ ok: false, error }`）。命中 codemode-only 配置且声明了 `structuredSchema` 的工具 MUST 只登记进总线、MUST NOT 交给 pi 注册；命中 codemode-only 但没有 `structuredSchema` 的工具 MUST 照常直接注册，MUST NOT 被隐藏。其余通过过滤的工具 MUST 照常交给 pi 注册。枚举 MUST 同时包含为 pi 注册的工具与 codemode-only 工具。`executeTool` MUST 在调用前用工具自身的参数 schema 校验参数，MUST 把校验失败与工具抛出的异常归一化成错误结果返回，MUST NOT 把异常抛给调用方。总线 MUST 由工厂创建、状态由闭包持有，MUST NOT 使用模块级可变状态。工具总线 MUST 只包含本次实际登记（未命中无条件禁用、属于选中工具集）的工具。

#### Scenario: 按名执行已注册工具

- **WHEN** 同入口内的模块用 `executeTool` 调用某个已注册工具并传入合法参数
- **THEN** 得到该工具的执行结果，等价于模型直接调用它

#### Scenario: 参数不合法

- **WHEN** `executeTool` 收到的参数不符合该工具的 schema
- **THEN** 返回错误结果（含校验信息），不执行工具，也不抛异常

#### Scenario: 工具执行抛错

- **WHEN** 工具执行过程中抛出异常
- **THEN** 返回错误结果（含错误信息），不把异常抛给调用方

#### Scenario: 查询不到的工具

- **WHEN** `executeTool` 或按名查询收到一个未注册（或已被禁用）的工具名
- **THEN** 返回明确的「工具不可用」错误结果，不执行任何东西

#### Scenario: codemode-only 工具只登记进总线

- **WHEN** 一个声明了 `structuredSchema` 的工具命中 codemode-only 配置
- **THEN** 它出现在总线的枚举与按名查询里，`executeTool` 能执行它，但它 MUST NOT 被交给 pi 注册

#### Scenario: 没有结构化输出的工具保持直接注册

- **WHEN** 一个没有声明 `structuredSchema` 的工具（例如 `Read`）命中 codemode-only 配置
- **THEN** 它照常交给 pi 注册、仍直接可用，并产生一条指明它没有结构化输出、未按 codemode-only 处理的警告

#### Scenario: 专用注册路径固定曝光方式

- **WHEN** 某模块调用总线的 codemode-only 注册入口注册一个工具
- **THEN** 该工具不问配置就按 codemode-only 登记：出现在总线枚举与按名查询里，codemode-only 执行入口能执行它，它 MUST NOT 被交给 pi；该入口接受的参数类型 MUST 要求工具声明 `structuredSchema`，其 `execute` MUST 直接返回结构化结果

#### Scenario: codemode-only 工具的结果是结构化结果

- **WHEN** 经 codemode-only 执行入口调用一个脚本工具
- **THEN** 成功时得到 `{ ok: true, value }`（`value` 与该工具声明的 `structuredSchema` 匹配），失败时得到 `{ ok: false, error }`；工具抛出的异常与参数校验失败 MUST 归一成 `{ ok: false, error }`，结果里没有 `content` / `details`

#### Scenario: executeTool 不执行 codemode-only 工具

- **WHEN** 用 `executeTool` 调用一个 codemode-only 工具
- **THEN** 返回明确的错误结果（指明该工具只能经 codemode 调用），不执行工具

#### Scenario: 专用注册路径仍受禁用过滤

- **WHEN** 走 codemode-only 注册入口的工具命中 `disabledTools`（可带 `models`）
- **THEN** 它不被登记进总线、执行入口也查不到它，注册调用返回未注册

### Requirement: codemode-only 工具

工具进 codemode 有两条路径，都必须以 codemode-only 形式注册（登记进工具总线、MUST NOT 交给 pi）：一是代码层调总线的 codemode-only 注册入口（曝光方式由模块自己决定，例如 gh 工具集），二是命中 `codemodeOnlyTools` 配置、未被禁用、且声明了 `structuredSchema` 的普通注册。两类工具在脚本侧的结果契约都是结构化结果（成功 `{ ok: true; value }`、结构化失败 `{ ok: false; error }`），两者都 MUST NOT 让工具出现在模型可见的工具清单与 active 工具列表里，也 MUST NOT 产生面向模型的 `promptSnippet` / `promptGuidelines`；模型仍可在 `codemode` 的工具描述里看到它的参数与返回类型声明。命中 `codemodeOnlyTools` 但没有声明 `structuredSchema` 的工具进不了 codemode，MUST NOT 被当作 codemode-only 处理——它 MUST 照常直接注册，并 MUST 产生一条指明其无结构化输出、保持直接可用的警告，避免配置意外把工具从模型面前移除。优先级是：`disabledTools` 更高——同时命中禁用与 codemode-only 时按禁用处理，既不交给 pi 也不登记进总线；其次是 schema 门控。扩展 MUST NOT 通过调整 pi 的 active 工具列表来实现 codemode-only。

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

#### Scenario: 代码层注册的工具不受配置解锁

- **WHEN** 某工具经代码层 codemode-only 入口注册，且配置里没有提到它
- **THEN** 它仍不交给 pi；配置只能禁用（`disabledTools`），不能让它变成模型可直接调用的工具
