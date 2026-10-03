# Spec Delta

## MODIFIED Requirements

### Requirement: 工具注册与可调用工具集合

扩展 MUST 注册名为 `codemode` 的工具，并 MUST 在注册时把脚本可调用的工具集合渲染进工具描述，为每个工具给出名字、说明、参数类型与返回类型。返回类型 MUST 由工具声明的输出结构推导：声明了 `structuredSchema` 的工具按该 schema 渲染，未声明的工具渲染为文本（`string`）。该集合 MUST 等于本仓库工具总线上实际注册的工具减去排除名单，排除名单为 `codemode` 自身、`spawn-agent`、两套文件工具集的读写工具（`Read` / `Edit` / `Write` 与 `read` / `edit` / `write`），以及两套工具集的搜索工具（`Grep` / `Glob` 与 `grep` / `glob`）；执行时 MUST 再与当前 active 工具列表求交（取不到 active 列表时不过滤）。脚本 MUST NOT 能调用排除名单里的任何工具名。

搜索工具被排除是因为脚本有更好的选择：用 `call("Bash", { command })` 跑 `rg` / `grep`，走同一个沙箱、拿得到退出码与结构化输出（见 `Bash` 的结构化结果），能拼管道也少一大截参数与输出模式的声明。

#### Scenario: 描述列出可调用工具

- **WHEN** 获取 `codemode` 的工具描述
- **THEN** 描述包含总线上除排除名单外每个工具的名字、说明与参数类型声明

#### Scenario: 描述给出每个工具的返回类型

- **WHEN** 某工具声明了输出结构，另一个工具没有
- **THEN** 描述里前者的返回类型按该结构渲染，后者的返回类型为文本（`string`）

#### Scenario: 集合外的工具不可调用

- **WHEN** 脚本调用一个不在总线上的工具名
- **THEN** 该调用在脚本内以错误失败，不产生任何宿主副作用

#### Scenario: 未启用的工具不可调用

- **WHEN** 脚本调用一个已注册但当前不 active 的工具（例如子代理工具白名单之外的工具）
- **THEN** 该调用失败，不执行该工具

#### Scenario: 脚本自身不可再调用 codemode

- **WHEN** 脚本尝试调用 `codemode`
- **THEN** 该调用失败，不会递归启动新的脚本

#### Scenario: 脚本不可调用 spawn-agent

- **WHEN** 脚本尝试调用 `spawn-agent`（即使该工具已注册且 active）
- **THEN** 该调用在脚本内以错误失败，不启动任何子代理，`codemode` 的工具描述里也不出现它的参数声明

#### Scenario: 脚本不可调用文件读写工具

- **WHEN** 脚本尝试调用 `Read` / `Edit` / `Write`（或小写的 `read` / `edit` / `write`），无论它们是否已注册且 active
- **THEN** 该调用在脚本内以错误失败，工具 MUST NOT 被执行，`codemode` 的工具描述里也不出现它们的参数声明；脚本要碰文件就用 `fs.read` / `fs.write`

#### Scenario: 脚本不可调用搜索工具

- **WHEN** 脚本尝试调用 `Grep` / `Glob`（或小写的 `grep` / `glob`），无论它们是否已注册且 active
- **THEN** 该调用在脚本内以错误失败，工具 MUST NOT 被执行，`codemode` 的工具描述里也不出现它们的参数声明；脚本要搜文件用 `call("Bash", { command })` 跑 `rg`

#### Scenario: 脚本用 Bash 拿退出码与输出

- **WHEN** 脚本 `call("Bash", { command: "rg -q needle file" })`
- **THEN** 调用 resolve 为 `Bash` 的结构化结果（`{ exitCode, output }`），脚本据 `exitCode` 分支，命令本身的非零退出不是调用失败
