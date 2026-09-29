# tool-registration Specification

## Purpose

让本仓库的所有工具由单一扩展入口按一份配置注册与启用：选择哪一套文件 IO 工具集、哪些工具可用（可带通配与按模型的条件），都由这份配置决定，而不是靠排除整个扩展入口文件。

## Requirements

### Requirement: 单一注册入口

本仓库注册工具的全部模块 MUST 由单一扩展入口注册，`pi.extensions` 中 MUST NOT 再有各自注册工具的分入口。该入口 MUST 按配置决定注册哪些工具，并 MUST 通过工具总线（见下一条）注册。工具模块同时 MUST 保留可独立按路径加载的形态（默认导出接受 `pi` 的注册函数），使子代理仍能按声明加载最小工具集，且行为与经由入口注册时一致。

#### Scenario: 工具清单由入口产生

- **WHEN** 会话加载本扩展
- **THEN** 模型可见的工具全部来自该单一入口，不存在由其他入口重复注册的同一工具

#### Scenario: 模块仍可按路径独立加载

- **WHEN** 子代理按声明的工具名加载对应模块文件
- **THEN** 该模块注册其声明范围内的工具，行为与经由入口注册时一致

### Requirement: 工具总线

注册层 MUST 实现一个工具总线，提供：注册（按配置过滤后交给 pi 注册并保留定义）、枚举（列出本次实际注册的工具定义）、按名查询、以及 `executeTool(name, args, options)`。`executeTool` MUST 在调用前用工具自身的参数 schema 校验参数，MUST 把校验失败与工具抛出的异常归一化成错误结果返回，MUST NOT 把异常抛给调用方。总线 MUST 由工厂创建、状态由闭包持有，MUST NOT 使用模块级可变状态。工具总线 MUST 只包含本次实际注册（未命中无条件禁用、属于选中工具集）的工具。

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

### Requirement: 启用配置

配置 MUST 读取 `~/.pi/agent/settings.json` 的 `personalExtensions` section，包含：

- `fileIo`：兜底的文件 IO 工具集，取值 `"claude-code"` 或 `"opencode"`，缺省 `"claude-code"`。
- `fileIoByModel`：可选数组，条目为 `{ models: string[], fileIo: "claude-code" | "opencode" }`，按顺序取第一条模型命中的条目覆盖 `fileIo`。
- `disabledTools` / `enabledTools`：可选数组，条目 MUST 是工具名模式字符串，或 `{ tools: string[], models?: string[] }`。工具名与模型名都用通配模式匹配；工具名按名称整体匹配；模型名 MUST 同时尝试匹配当前模型的 `model id` 与 `provider/model` 两种写法。

工具生效规则 = 命中 `disabledTools` 且未命中 `enabledTools`；带 `models` 的条目只在当前模型命中时才参与判定。配置缺失时 MUST 使用默认值继续工作；出现非法条目，或某个工具名模式匹配不到任何工具（含被规则禁用的工具）时，MUST 产生可诊断的警告，且 MUST NOT 影响其余配置项生效。

#### Scenario: 未配置时使用默认值

- **WHEN** settings.json 没有 `personalExtensions` section
- **THEN** 注册 claude-code 那套文件 IO 工具集，且不额外禁用任何工具

#### Scenario: 通配匹配

- **WHEN** `disabledTools` 含 `"talk-*"`
- **THEN** 所有以 `talk-` 开头的工具都被命中，其他工具不受影响

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

### Requirement: 文件 IO 工具集二选一

按上述规则选中的那一套文件 IO 工具集 MUST 被完整注册，另一套的任何工具 MUST NOT 注册，也 MUST NOT 出现在模型可见的工具清单里。

#### Scenario: 选择 claude-code

- **WHEN** 生效的工具集为 `claude-code`
- **THEN** 注册 `Read` / `Edit` / `Write` / `Glob` / `Grep` 等 claude-code 工具，且不注册 opencode 的 `read` / `edit` / `write` / `glob` / `grep` / `bash`

#### Scenario: 选择 opencode

- **WHEN** 生效的工具集为 `opencode`
- **THEN** 注册 opencode 那套文件与搜索工具，且不注册 claude-code 的对应工具

### Requirement: 工具可用性

工具可用性 MUST 在每个会话启动时判定一次：以该会话启动时的模型为条件，选出生效的工具集、算出被禁用的工具，然后注册。被禁用的工具 MUST NOT 注册，MUST NOT 出现在模型可见的工具清单与工具总线上。同一会话内切换模型 MUST NOT 改变已注册的工具集合（下一次会话启动时重新判定）。扩展 MUST NOT 通过调整 pi 的 active 工具列表来改变可用性，MUST NOT 影响其他来源（pi 的 `defaultTools`、CLI `--tools`、子代理工具白名单）对工具的选择。

#### Scenario: 无条件禁用的工具不存在

- **WHEN** `disabledTools` 含某工具名且该条目不限定模型
- **THEN** 该工具不注册，不出现在工具清单里，也不在工具总线上

#### Scenario: 模型规则按启动时的模型判定

- **WHEN** 规则命中会话启动时的模型
- **THEN** 对应工具（或整条工具集）不注册

#### Scenario: 新会话按自己的模型重新判定

- **WHEN** 用 `/new`（或 resume / fork）启动一个模型不同的会话
- **THEN** 新会话按它自己的模型注册对应工具集，与会话内切换前的那一套无关

#### Scenario: 同一会话内切换模型不改工具面

- **WHEN** 同一会话内用 `/model` 切换到另一条规则命中的模型
- **THEN** 已注册的工具集合不变；新规则在下一个会话启动时生效

#### Scenario: 不覆盖其他来源的选择

- **WHEN** 某个工具被 pi 的 `defaultTools` 或子代理工具白名单排除
- **THEN** 扩展 MUST NOT 把它重新启用或加入 active 列表

### Requirement: 注册故障隔离

单个模块的注册失败 MUST NOT 阻止其他模块注册工具。失败 MUST 以警告形式上报（含模块名与错误信息），MUST NOT 静默吞掉。

#### Scenario: 一个模块失败其他模块照常

- **WHEN** 某个模块在注册阶段抛错
- **THEN** 其余模块的工具照常注册可用，并且有一条指明该模块与错误的警告

### Requirement: 注册不建立资源

注册工具定义 MUST 只登记定义：注册本身 MUST NOT 触发工具执行路径上的资源创建（子进程、引擎连接、LSP 服务器进程、外部命令）。会话启动时因注册而额外建立的资源 MUST 为零。模块既有的资源时机不变（例如 talk 在扩展加载期打开 SQLite、aft 在会话启动期创建 bridge 池、LSP 服务在会话启动期按配置创建，都是本变更之前的行为，本变更不改变它们）。

#### Scenario: 未使用的工具不产生副作用

- **WHEN** 会话启动、工具已注册，但没有任何工具调用
- **THEN** 注册过程本身没有启动外部命令或引擎连接；未使用模块不因注册而产生额外进程
