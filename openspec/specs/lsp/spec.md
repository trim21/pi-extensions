# lsp Specification

## Purpose

read / edit / write 工具内置 LSP 诊断：写文件后等待并报告 ERROR 级诊断。LSP 服务器通过一份 JSON 配置声明如何启动，无需为每种语言写 adapter。

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

服务器按配置启动，包含匹配规则、项目根定位与可执行文件发现。

#### Scenario: 按 include glob 启用

- **WHEN** 文件匹配任一服务器的 `include` glob（相对项目根或调用 cwd）
- **THEN** 该服务器启用（支持 `!` 否定排除）

#### Scenario: 项目根定位

- **WHEN** 配置了 `rootMarkers`
- **THEN** 从文件目录向上查找标记文件作为项目根；缺省用调用 cwd

#### Scenario: 可执行文件发现

- **WHEN** 配置了 `bin`
- **THEN** 按绝对路径 / 相对调用 cwd / 名字（先在项目内 `node_modules/.bin`、`.venv/bin`、`venv/bin` 找，再走 PATH）解析

### Requirement: 工作区文件事件同步

系统 SHALL 为会话工作区目录维护**单个**递归文件监听器，把工作区内的文件创建 / 修改 / 删除事件以 `workspace/didChangeWatchedFiles` 批量通知给已启动的语言服务器。事件源不限于本 agent 自己写入的文件。

#### Scenario: 事件类型映射

- **WHEN** 工作区内文件被创建、内容被修改、或被删除
- **THEN** 分别以 `didChangeWatchedFiles` type 1（created）、2（changed）、3（deleted）通知；删除与创建须能区分（底层事件不区分二者时按文件当前是否存在判定）

#### Scenario: 工作区之外不跟踪

- **WHEN** 变更路径不在会话 `cwd` 之内（含服务器 root 位于 `cwd` 之上的情况）
- **THEN** 不产生任何通知，保持现有仅由工具触发的同步行为

#### Scenario: 去抖与批量上限

- **WHEN** 短时间内产生大量事件（安装依赖、构建、分支切换）
- **THEN** 事件合并为有限批次发送；单批超过上限时截断并一次性提示，不逐条刷屏

#### Scenario: 忽略规则

- **WHEN** 事件路径命中内置忽略（`node_modules`、`.git`、`dist`、`build`、`.venv`、`target`、`coverage`）或配置追加的忽略 glob
- **THEN** 不转发该路径

#### Scenario: 监听器不可用时降级

- **WHEN** 监听器无法启动或中途失败（如系统 watch 资源耗尽）
- **THEN** 关闭该监听器并一次性提示，写后诊断链路保持原有行为，不使工具调用失败

#### Scenario: 生命周期跟随服务器

- **WHEN** 工作区内最后一个服务器 client 关闭（`/lsp-stop`、`/lsp-reload`、session 结束）
- **THEN** 监听器停止；服务器再次启动时重新建立
- **WHEN** 会话工作目录变化
- **THEN** 在新工作目录上重建监听器

### Requirement: 尊重服务器注册的监听 pattern

系统 SHALL 记录服务器通过 `client/registerCapability` 注册的 `workspace/didChangeWatchedFiles` watchers glob（`client/unregisterCapability` 时移除），并按各服务器的 pattern 及其处理语言的扩展名过滤待投递事件。MUST NOT 在 ack 注册请求之后丢弃其 pattern 而不投递。

#### Scenario: 配置文件变更送达服务器

- **WHEN** 服务器注册过的配置文件（如 `pyproject.toml`、`ruff.toml`、`pyrightconfig.json`）在工具之外被修改
- **THEN** 对应服务器收到该文件的变更通知并据此重载配置

#### Scenario: 重复注册幂等

- **WHEN** 同一服务器多次注册同一 pattern（不同 registration id）
- **THEN** 记录并按 id 去重，不因重复注册而多份投递

### Requirement: 文档驻留 LRU

系统 SHALL 以有界 LRU 维护"保持打开"的文档集合：仅 edit / write 产出的文档进入驻留集合（进入时 `didOpen`，已驻留时 `didChange`），淘汰时 `didClose`；`read` MUST NOT 使文档长驻。

#### Scenario: 诊断请求要求文档处于驻留状态

- **WHEN** 对某文件请求 document 级诊断
- **THEN** 该文件当时处于驻留（已 `didOpen`）状态；未打开的文档服务器返回空诊断，故不得在未打开时等待诊断

#### Scenario: 容量上限触发淘汰

- **WHEN** 驻留文档数超过配置容量
- **THEN** 最久未使用者优先 `didClose` 并移出驻留集合，不再被服务器当作打开文档

#### Scenario: 读取不占驻留名额

- **WHEN** 仅通过 read 工具读取文件
- **THEN** 该文件不因读取而长驻为打开文档；服务器通过文件事件同步感知其存在

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

### Requirement: 写后诊断

写文件后等待服务器诊断，报告 ERROR 级诊断。系统 MUST 在诊断收集完成之后才关闭该文档——服务器可能在 `didClose` 时推送空诊断。

#### Scenario: 写后报告诊断

- **WHEN** 写工具写入文件
- **THEN** 等待（`diagnosticsWaitMs`）并报告 ERROR 级诊断

#### Scenario: 超时与配置分离

- **WHEN** 配置 `startupTimeoutMs` / `diagnosticsWaitMs` / `initializeTimeoutMs`
- **THEN** 覆盖全局与默认值；`initializationOptions` 进 initialize 请求、`settings` 进 didChangeConfiguration / workspace/configuration 请求

#### Scenario: 关闭不得早于诊断收集

- **WHEN** 本次写入的诊断尚未收集完成
- **THEN** 不得因 LRU 淘汰或外部改动而关闭该文档；`didClose` 只发生在诊断汇总之后

## Implementation

实现位于 `src/lib/lsp/`：read / edit / write 工具写文件后经 LSP 客户端请求诊断并报告 ERROR 级诊断。

- **配置解析**（`server-config.ts`）：`~/.pi/agent/lsp.json`（全局）与 `.pi/lsp.json`（项目）合并——顶层字段本地覆盖全局，`servers` 按 id 合并（同名整体覆盖、新 id 新增、全局其余保留）；无内置默认服务器，服务器全部来自配置，禁用某服务器用顶层 `disabled: [id]`。
- **服务器启动**（`adapter.ts`）：按 `include` glob 匹配启用（`!` 否定排除），`rootMarkers` 向上定位项目根（缺省调用 cwd），`bin` 按绝对路径 / 相对调用 cwd / 名字（先项目内 `node_modules/.bin`、`.venv/bin`、`venv/bin`，再 PATH）解析；`cwd` 支持 `{root}` / `{cwd}` 模板。
- **协议**：`initializationOptions` 进 initialize 请求，`settings` 进 didChangeConfiguration / workspace/configuration；languageId 按扩展名映射（缺省内置映射表）。
- **超时**：per-server `startupTimeoutMs` / `diagnosticsWaitMs` 覆盖全局与默认值。
- **文件监听**（`watcher.ts`）：会话 cwd 上的递归 fs.watch（`node:fs/promises`），尾部去抖 + 最长 flush 批量回调；事件按各 client 的 root 前缀 / 注册 pattern / 扩展名过滤后以 `workspace/didChangeWatchedFiles` 投递（created=1 / changed=2 / deleted=3）；监听器失败降级提示，不影响诊断链路。
- **驻留与退场**（`client.ts`）：edit/write 进入有界 LRU（`maxOpenDocuments`，缺省 32），淘汰时 `didClose`；驻留文档被外部改动时先 `didClose` 再发 changed 事件，内容一致的自身写入 echo 完全忽略；read 只发文件事件通知，不驻留。

涉及文件：`src/lib/lsp/`（lsp.ts / server-config.ts / adapter.ts / client.ts / watcher.ts）。
