## ADDED Requirements

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

## MODIFIED Requirements

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
