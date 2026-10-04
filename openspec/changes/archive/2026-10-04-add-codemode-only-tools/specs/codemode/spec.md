# Spec Delta

## MODIFIED Requirements

### Requirement: 工具注册与可调用工具集合

扩展 MUST 注册名为 `codemode` 的工具，并 MUST 在注册时把脚本可调用的工具集合渲染进工具描述，为每个工具给出名字、说明、参数类型与返回类型。返回类型 MUST 按该工具的 `structuredSchema` 渲染——可调用集合里每个工具都声明了它，因此每个条目都有确定的返回类型。

可调用集合 MUST 只包含本仓库工具总线上**声明了 `structuredSchema`** 的工具；在此之上，MUST 包含所有 codemode-only 工具，且对非 codemode-only 的工具 MUST 再与当前 active 工具列表求交（取不到 active 列表时不过滤）。codemode-only 工具不在 active 列表里是常态，MUST NOT 因此把它排除。这条准入条件 MUST 是唯一的集合规则：MUST NOT 再维护手工的工具名单（黑名单会随工具增减而漂移）。理由是脚本拿到的返回值必须有确定的形状：只给文本的工具在脚本里既不能当数据用（得解析文本），也没有返回类型能写进声明。

由此天然不在集合里、且各自理由独立成立的例子：`codemode` 自身与 `spawn-agent`（没有结构化输出）、两套文件工具集的读写工具（脚本用 `fs.read` / `fs.write`，不重复一套为 LLM 上下文设计的行号/锚点语义）、两套工具集的搜索工具（脚本用 `call("Bash", { command })` 跑 `rg` / `grep`，走同一个沙箱、拿得到退出码，还能拼管道）、`lsp-rename`（写工具）、talk 工具与会话工具（会把执行时间交给用户或另一个 agent 的回答）。这些工具 MUST NOT 需要写进特殊名单：它们没有声明结构化输出，因此自然不在集合里。

脚本 MUST NOT 能调用不在集合里的任何工具名。

#### Scenario: 描述列出可调用工具

- **WHEN** 获取 `codemode` 的工具描述
- **THEN** 描述包含总线上每个声明了 `structuredSchema` 且（属于 codemode-only 或当前 active）的工具的名字、说明与参数类型声明，且不含其它任何工具名

#### Scenario: 描述给出每个工具的返回类型

- **WHEN** 某个工具声明了 `structuredSchema`
- **THEN** 描述里它的返回类型按该 schema 渲染；没声明 schema 的工具不出现（因此不存在「未声明就渲染成文本」的条目）

#### Scenario: 集合外的工具不可调用

- **WHEN** 脚本调用一个不在总线上的工具名，或一个已注册但没有声明 `structuredSchema` 的工具名
- **THEN** 该调用在脚本内以错误失败，不产生任何宿主副作用

#### Scenario: 未启用的工具不可调用

- **WHEN** 脚本调用一个已注册、已声明结构化输出但不是 codemode-only 的工具，而它当前不 active（例如子代理工具白名单之外的工具）
- **THEN** 该调用失败，不执行该工具

#### Scenario: codemode-only 工具可调用

- **WHEN** 脚本调用一个已注册为 codemode-only 的工具
- **THEN** 该调用执行该工具，即使它不在模型可见的工具清单与 active 列表里

#### Scenario: codemode-only 工具出现在描述里

- **WHEN** 某个已注册工具是 codemode-only 且声明了 `structuredSchema`
- **THEN** `codemode` 的工具描述里有它的名字、说明、参数类型与返回类型

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
- **THEN** 该调用在脚本内以错误失败，工具 MUST NOT 被执行，`codemode` 的工具描述里也不出现它们；脚本要搜文件用 `call("Bash", { command })` 跑 `rg`

#### Scenario: 没有结构化输出的工具不可调用

- **WHEN** 脚本尝试调用 `lsp-rename` / `talk-ask` / `talk-send` / `TodoWrite`（或对应的小写名），或任何其它没有声明 `structuredSchema` 的工具
- **THEN** 该调用在脚本内以错误失败，工具 MUST NOT 被执行，`codemode` 的工具描述里也不出现它们（没有 schema 就没有返回类型可渲染）

#### Scenario: 脚本用 Bash 拿退出码与输出

- **WHEN** 脚本 `call("Bash", { command: "rg -q needle file" })`
- **THEN** 调用 resolve 为 `Bash` 的结构化结果（`{ exitCode, output }`），脚本据 `exitCode` 分支，命令本身的非零退出不是调用失败

#### Scenario: 声明了结构化输出却没给载荷

- **WHEN** 脚本调用一个声明了 `structuredSchema` 但返回结果里没有 `structuredResult` 的工具
- **THEN** 该调用在脚本内以 `CallFailedError` 失败（运行时复核由工具总线负责），脚本可以捕获并继续
