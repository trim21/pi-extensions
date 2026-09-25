# lsp Specification

## Purpose

read / edit / write 工具内置 LSP 诊断：读取或写入文件后等待并报告该文件的诊断。LSP 服务器通过一份 JSON 配置声明如何启动，无需为每种语言写 adapter。

## Requirements

### Requirement: 服务器配置

LSP 服务器 SHALL 全部由 JSON 配置声明，项目配置优先于全局，按服务器 id 合并；不存在内置默认服务器集合。每个服务器可声明 `kind`（`language` | `linter`，缺省 `language`）。

#### Scenario: 项目覆盖全局

- **WHEN** 项目 `.pi/lsp.json` 与全局 `~/.pi/agent/lsp.json` 都存在
- **THEN** 顶层字段本地覆盖全局；`servers` 按 id 合并（同名整体覆盖、新 id 新增、全局其余保留）

#### Scenario: 无内置默认服务器

- **WHEN** 全局与本地配置都没有定义 `servers`
- **THEN** 不启动任何语言服务器；写文件后诊断集合为空，不报错也不提示配置缺失

#### Scenario: 用顶层列表启用或禁用服务器

- **WHEN** 需要排除某个已在配置中定义的服务器
- **THEN** 用顶层 `disabled: [id]`（未注册的 id 直接忽略）；顶层 `enabled: [id, ...]` 为白名单，引用未注册的 id 视为配置错误并在加载时提示

#### Scenario: 声明服务器类型

- **WHEN** `servers` 中某服务器配置了 `kind`
- **THEN** 仅接受 `language`（真语言服务器，如 pyright / clangd / vtsls）或 `linter`（只实现 LSP 协议的 lint，如 ruff）；缺省为 `language`；其他值按配置错误拒绝

### Requirement: 符号级请求按服务器类型过滤

符号级功能（rename 等）SHALL 只会话 `kind: "language"` 的服务器；`linter` 类服务器只参与诊断。

#### Scenario: linter 不参与符号级功能

- **WHEN** 文件同时匹配 `language` 与 `linter` 类服务器，模型调用符号级工具
- **THEN** 只使用 `language` 类服务器；`linter` 类服务器不因此被 spawn

#### Scenario: 诊断不受影响

- **WHEN** 服务器配置为 `kind: "linter"`
- **THEN** 其诊断行为（写文件后等待与报告）与 `language` 类服务器完全一致

### Requirement: 服务器启动

服务器 SHALL 按配置启动，包含匹配规则、项目根定位、可执行文件发现与初始化参数生成。

#### Scenario: 按 include glob 启用

- **WHEN** 文件匹配任一服务器的 `include` glob（相对项目根或调用 cwd）
- **THEN** 该服务器启用（支持 `!` 否定排除）

#### Scenario: 项目根定位

- **WHEN** 服务器未配置 `rootMarkers`
- **THEN** 项目根即调用 cwd；配置了 `workingDir` 时即该目录（相对调用 cwd 解析，绝对路径原样），文件不在该目录内时不启用该服务器
- **WHEN** 配置了 `rootMarkers`（非空字符串数组，元素为精确文件名，目录名亦可）
- **THEN** 从会话 cwd 沿文件路径逐级向下查找，第一个含任一标记的目录即项目根（cwd 自身含标记时即 cwd，取最外层命中）；路径上没有命中时回退会话 cwd；搜索 MUST NOT 越过会话 cwd

#### Scenario: workingDir 与 rootMarkers 互斥

- **WHEN** 同一服务器同时配置了 `workingDir` 与 `rootMarkers`
- **THEN** 视为配置错误并在配置解析时报错，不静默忽略任一字段

#### Scenario: 同一服务器多个项目根

- **WHEN** 同一服务器的文件落在不同项目根（如容器 cwd 下并列的 `~/projects/a` 与 `~/projects/b`）
- **THEN** 每个项目根各自持有一个独立服务器实例；`bin` 解析、`{root}` 模板与项目工作区二进制查找均按该文件的项目根生效；状态与启动失败记录按项目根分别维护
- **WHEN** 重载该服务器
- **THEN** 此前运行中的每个项目根实例都被恢复

#### Scenario: 可执行文件发现

- **WHEN** 配置了 `bin`
- **THEN** 按绝对路径 / 相对调用 cwd / 名字（先在项目内 `node_modules/.bin`、`.venv/bin`、`venv/bin` 找，再走 PATH）解析

#### Scenario: 初始化参数由命令生成

- **WHEN** 配置了 `initializationOptionsCommand`
- **THEN** 启动前执行该命令：argv 直接执行（不经 shell），参数项支持 `{root}` / `{cwd}` 模板与 `${VAR}` 插值，cwd 为该服务器的项目根，环境为 process env 叠加已解析的 `env`
- **WHEN** 命令成功退出且 stdout 是 JSON 对象
- **THEN** 该对象与静态 `initializationOptions` 深合并（命令输出优先，嵌套对象逐层递归）作为 initialize 请求的 `initializationOptions`
- **WHEN** 命令非零退出、输出为空、或 stdout 不是 JSON 对象
- **THEN** 该服务器启动失败并报错（错误信息含具体命令、退出码与 stderr），SHALL NOT 启动进程

### Requirement: 工作区文件事件同步

系统 SHALL 为当前活跃服务器实例的项目根维护递归文件监听器，把监听范围内的文件创建 / 修改 / 删除事件以 `workspace/didChangeWatchedFiles` 批量通知给已启动的语言服务器。事件源不限于本 agent 自己写入的文件。同一目录只监听一次：被其他活跃 root 包含的 root 不单独建立监听器；root 不在会话 cwd 内时退化为监听 cwd。

#### Scenario: 事件类型映射

- **WHEN** 监听范围内文件被创建、内容被修改、或被删除
- **THEN** 分别以 `didChangeWatchedFiles` type 1（created）、2（changed）、3（deleted）通知；删除与创建须能区分（底层事件不区分二者时按文件当前是否存在判定）

#### Scenario: 工作区之外不跟踪

- **WHEN** 变更路径不在会话 `cwd` 之内（含服务器 root 位于 `cwd` 之上的情况）
- **THEN** 不产生任何通知，保持现有仅由工具触发的同步行为

#### Scenario: 按活跃项目根限定监听范围

- **WHEN** 活跃 client 的 root 是会话 cwd 的子目录（`rootMarkers` / `workingDir` 场景）
- **THEN** 只对活跃 root 建立递归监听器，cwd 下没有活跃 client 的其他目录 MUST NOT 产生任何文件监听；投递仍按各 client 的 root 与注册 pattern 过滤
- **WHEN** 多个活跃 client 的 root 存在包含关系（如 `/repo` 与 `/repo/packages/a`）
- **THEN** 只监听最外层 root，不为被包含的 root 重复建立监听器

#### Scenario: 去抖与批量上限

- **WHEN** 短时间内产生大量事件（安装依赖、构建、分支切换）
- **THEN** 事件合并为有限批次发送；单批超过上限时截断并一次性提示，不逐条刷屏

#### Scenario: 忽略规则

- **WHEN** 事件路径命中内置忽略（`node_modules`、`.git`、`dist`、`build`、`.venv`、`venv`、`target`、`coverage`）或配置追加的忽略 glob
- **THEN** 不转发该路径

#### Scenario: 监听器不可用时降级

- **WHEN** 监听器无法启动或中途失败（如系统 watch 资源耗尽）
- **THEN** 关闭该 root 的监听器并一次性提示，写后诊断链路保持原有行为，不使工具调用失败
- **WHEN** 失败原因是资源耗尽（ENOSPC / EMFILE 等系统级限制）
- **THEN** 在 `/lsp-reload` 之前不再为该 root 重建监听器（重试前须先提高系统限制）

#### Scenario: 生命周期跟随服务器

- **WHEN** 服务器 client 启动
- **THEN** 其项目根纳入监听范围（已被其他 root 覆盖时不重复监听）
- **WHEN** 工作区内最后一个使用某 root 的服务器 client 关闭（`/lsp-stop`、`/lsp-reload`、session 结束）
- **THEN** 该 root 的监听器停止；服务器再次启动时重新建立
- **WHEN** 会话工作目录变化
- **THEN** 按新的 cwd 重算监听范围

### Requirement: 尊重服务器注册的监听 pattern

系统 SHALL 记录服务器通过 `client/registerCapability` 注册的 `workspace/didChangeWatchedFiles` watchers glob（`client/unregisterCapability` 时移除），并按各服务器的 pattern 及其处理语言的扩展名过滤待投递事件。MUST NOT 在 ack 注册请求之后丢弃其 pattern 而不投递。

#### Scenario: 配置文件变更送达服务器

- **WHEN** 服务器注册过的配置文件（如 `pyproject.toml`、`ruff.toml`、`pyrightconfig.json`）在工具之外被修改
- **THEN** 对应服务器收到该文件的变更通知并据此重载配置

#### Scenario: 重复注册幂等

- **WHEN** 同一服务器多次注册同一 pattern（不同 registration id）
- **THEN** 记录并按 id 去重，不因重复注册而多份投递

### Requirement: 文档驻留 LRU

系统 SHALL 以有界 LRU 维护"保持打开"的文档集合：read / edit / write 产出的文档进入驻留集合（进入时 `didOpen`，已驻留时 `didChange`），淘汰时 `didClose`。

#### Scenario: 诊断请求要求文档处于驻留状态

- **WHEN** 对某文件请求 document 级诊断
- **THEN** 该文件当时处于驻留（已 `didOpen`）状态；未打开的文档服务器返回空诊断，故不得在未打开时等待诊断

#### Scenario: 容量上限触发淘汰

- **WHEN** 驻留文档数超过配置容量
- **THEN** 最久未使用者优先 `didClose` 并移出驻留集合，不再被服务器当作打开文档

#### Scenario: 读取也报告诊断

- **WHEN** read 工具读取一个已启用 LSP 服务器的文件
- **THEN** 该文件进入驻留集合、等待其 document 级诊断，并与 edit / write 同样报告 ERROR / WARN

#### Scenario: 淘汰后再次编辑

- **WHEN** 曾被编辑、后被淘汰关闭的文件再次被 edit / write
- **THEN** 重新 `didOpen` 并按新内容产出诊断

### Requirement: 驻留文档的外部改动退场

WHEN 文件监听器报告某个仍在驻留集合中的文档被外部改动，系统 SHALL 先 `didClose` 再发 `didChangeWatchedFiles`，让服务器回落到读磁盘；MUST NOT 通过 bump 文档版本同步外部改动。内容一致的自身写入 echo SHALL NOT 触发任何通知。

#### Scenario: 自身写入不重复通知

- **WHEN** edit / write 自身写入触发监听事件，磁盘内容与已同步文本一致
- **THEN** 既不发送 `didChange` 也不发送 `didChangeWatchedFiles`

#### Scenario: 外部改动导致退场

- **WHEN** 驻留文档被工具之外的写入者改写
- **THEN** 该文档被关闭（服务器改用磁盘真相）并收到一条 changed 事件

#### Scenario: 不干扰写后等待

- **WHEN** 写后诊断等待窗口内收到同路径的监听事件
- **THEN** 本次写入的诊断结果仍在窗口内返回，不空转到超时

### Requirement: 读后与写后诊断

读取或写入文件后等待服务器诊断，报告 ERROR / WARN 诊断。系统 MUST 在诊断收集完成之后才关闭该文档——服务器可能在 `didClose` 时推送空诊断。

#### Scenario: 写后报告诊断

- **WHEN** 写工具写入文件
- **THEN** 等待（`diagnosticsWaitMs`）并报告 ERROR / WARN 诊断

#### Scenario: 读后报告诊断

- **WHEN** read 工具读取文件
- **THEN** 等待（`diagnosticsWaitMs`）并把该文件的 ERROR / WARN 诊断附在读取结果之后

#### Scenario: 报告完整计数与截断状态

- **WHEN** 报告某文件的诊断（每文件最多列出 5 条）
- **THEN** 标题固定为 `LSP diagnostics detected in this file`；未列出的部分在块尾以 `... and N errors, M warnings` 给出严重级别构成（为 0 的一类省略），未截断时没有该行

#### Scenario: 超时与配置分离

- **WHEN** 配置 `startupTimeoutMs` / `diagnosticsWaitMs` / `initializeTimeoutMs`
- **THEN** 覆盖全局与默认值；`initializationOptions` 进 initialize 请求、`settings` 进 didChangeConfiguration / workspace/configuration 请求

#### Scenario: 关闭不得早于诊断收集

- **WHEN** 本次写入的诊断尚未收集完成
- **THEN** 不得因 LRU 淘汰或外部改动而关闭该文档；`didClose` 只发生在诊断汇总之后

### Requirement: LSP 工具条件注册

LSP 专属工具（`lsp-rename`、`lsp-find-definition`、`lsp-find-reference`、`lsp-inspect`）SHALL 仅在当前会话存在 enabled 的 LSP 服务器时注册并对模型可见；read / edit / write 等文件工具 SHALL 无条件注册，不受 LSP 配置影响。

#### Scenario: 未配置 lsp.json

- **WHEN** 会话 cwd 及全局均无 `lsp.json` 或 `servers` 为空
- **THEN** LSP 专属工具不出现在模型工具列表中；文件工具正常注册

#### Scenario: 配置有效

- **WHEN** `lsp.json` 定义了至少一个 enabled 服务器
- **THEN** LSP 专属工具在首轮对话前注册完成并对模型可见

#### Scenario: 子代理工具白名单

- **WHEN** 子代理通过工具白名单声明 LSP 专属工具
- **THEN** 白名单过滤发生在注册之后的每次工具表重建，迟到注册的白名单内工具正常激活

### Requirement: 惰性生命周期

LSP 配置 SHALL 在 `session_start` 时加载并校验（pi await 该事件）；配置有效时才创建 service 实例，服务器进程仍保持首次工具调用时惰性 spawn。扩展实例随会话重建（reload / new / resume / fork）时，manager 与其闭包状态 SHALL 一并重建，旧实例的进程由 `session_shutdown` 清理。

#### Scenario: 配置错误降级

- **WHEN** `lsp.json` 存在但解析或校验失败
- **THEN** 向用户提示错误，LSP 保持 disabled，文件工具照常工作，不阻断会话启动

#### Scenario: 会话切换无泄漏

- **WHEN** 用户执行 /new、/resume 或 /fork
- **THEN** 旧实例在 session_shutdown 时关闭全部服务器进程；新会话的 manager 从零构建

### Requirement: service 不可用时的降级

文件工具对 LSP service 的访问 SHALL 通过惰性访问器完成；service 未创建或 disabled 时，访问器 SHALL 返回共享的 no-op service（诊断与文件事件通知为空操作），SHALL NOT 抛错或反复重建。

#### Scenario: 未配置时的写后诊断

- **WHEN** LSP disabled 时调用 edit / write
- **THEN** 工具正常完成写入，诊断输出为空，行为与"无匹配服务器"时一致

#### Scenario: 管理命令在 disabled 状态

- **WHEN** LSP disabled 时调用 /lsp-stop、/lsp-start 或 /lsp-reload
- **THEN** 命令给出"LSP 未配置"类的友好提示，不报错不 spawn 进程

## Implementation

实现位于 `src/lib/lsp/`：read / edit / write 工具读取或写入文件后经 LSP 客户端请求诊断并报告 ERROR / WARN 诊断。

- **配置解析**（`server-config.ts`）：`~/.pi/agent/lsp.json`（全局）与 `.pi/lsp.json`（项目）合并——顶层字段本地覆盖全局，`servers` 按 id 合并（同名整体覆盖、新 id 新增、全局其余保留）；无内置默认服务器，服务器全部来自配置，禁用某服务器用顶层 `disabled: [id]`。
- **服务器启动**（`adapter.ts` / `server-config.ts`）：按 `include` glob 匹配启用（`!` 否定排除）；root 由 `serverRoot` 解析——配置 `rootMarkers` 时从调用 cwd 沿文件路径向下找第一个含标记的目录（cwd 自身命中即 cwd，未命中回退 cwd），否则即 `workingDir`（相对调用 cwd 解析）或调用 cwd；两者互斥，同时配置在 `resolveConfig` 报错。同一服务器可为不同 root 各启动一个实例。`bin` 按绝对路径 / 相对调用 cwd / 名字（先项目内 `node_modules/.bin`、`.venv/bin`、`venv/bin`，再 PATH）解析，`env` 的 `{root}` / `{cwd}` 模板按该文件的 root 生效。`env` 的 `{sh}`（cwd 为调用 cwd）与 `initializationOptionsCommand`（cwd 为该项目根、环境含已解析的 `env`）都在 spawn 前执行，后者 stdout 的 JSON 对象与静态 `initializationOptions` 深合并（命令输出优先）。
- **协议**：`initializationOptions` 进 initialize 请求，`settings` 进 didChangeConfiguration / workspace/configuration；languageId 按扩展名映射（缺省内置映射表）。
- **超时**：per-server `startupTimeoutMs` / `diagnosticsWaitMs` 覆盖全局与默认值。
- **文件监听**（`watcher.ts` / `lsp.ts`）：`@parcel/watcher` 递归监听**活跃 client 的项目根**（root 去重、不越 cwd，无活跃 client 不监听；内核层 ignore 使被忽略目录不建 watch），尾部去抖 + 最长 flush 批量回调；事件按各 client 的 root 前缀 / 注册 pattern / 扩展名过滤后以 `workspace/didChangeWatchedFiles` 投递（created=1 / changed=2 / deleted=3）；监听器失败降级提示（ENOSPC 等资源耗尽时停用该 root 直到 `/lsp-reload`），不影响诊断链路。
- **驻留与退场**（`client.ts`）：read / edit / write 进入有界 LRU（`maxOpenDocuments`，缺省 32），淘汰时 `didClose`；驻留文档被外部改动时先 `didClose` 再发 changed 事件，内容一致的自身写入 echo 完全忽略。

涉及文件：`src/lib/lsp/`（lsp.ts / server-config.ts / adapter.ts / client.ts / watcher.ts / launch.ts / bin.ts / language.ts / diagnostic.ts / rename.ts / rename-tool.ts / inspect-tool.ts）。
