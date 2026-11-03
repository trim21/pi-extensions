# Spec Delta

## MODIFIED Requirements

### Requirement: 读后与写后诊断

读取或写入文件后等待服务器诊断，报告 ERROR / WARN 诊断。诊断 SHALL 只来自拥有该文件的活跃服务器 client：文件在会话 cwd 内，且至少一个 client 的 root 与 `include` 覆盖它；不满足的文件不报告诊断。系统 MUST 在诊断收集完成之后才关闭该文档——服务器可能在 `didClose` 时推送空诊断。

#### Scenario: 写后报告诊断

- **WHEN** 写工具写入文件
- **THEN** 等待（`diagnosticsWaitMs`）并报告 ERROR / WARN 诊断

#### Scenario: 读后报告诊断

- **WHEN** read 工具读取文件
- **THEN** 等待（`diagnosticsWaitMs`）并把该文件的 ERROR / WARN 诊断附在读取结果之后

#### Scenario: 工作区外文件不报告诊断

- **WHEN** read / edit / write 的文件位于会话 cwd 之外
- **THEN** 不为它 `didOpen`、不等待诊断，诊断报告为空

#### Scenario: 服务器 root 高于 cwd 时的归属边界

- **WHEN** 服务器 root 是 cwd 的祖先目录（如 `workingDir` 指向上级目录），文件在 root 内但在 cwd 外
- **THEN** 该文件仍不属于活跃工作区，读后 / 写后诊断报告为空

#### Scenario: 不属于任何服务器工作区的文件

- **WHEN** 文件在 cwd 内，但没有任何活跃 client 的 root 与 `include` 覆盖它
- **THEN** 诊断报告为空，即使某个服务器曾为同一路径推送过诊断

#### Scenario: 服务器 root 之外的诊断不外溢

- **WHEN** 某服务器为它 root 之外的文件推送或 pull 到诊断（如 project references、extraPaths）
- **THEN** 该诊断不计入该文件的读后 / 写后报告，除非另一个拥有该文件的 client 也报出

#### Scenario: 报告完整计数与截断状态

- **WHEN** 报告某文件的诊断（每文件最多列出 5 条）
- **THEN** 标题固定为 `LSP diagnostics detected in this file`；未列出的部分在块尾以 `... and N errors, M warnings` 给出严重级别构成（为 0 的一类省略），未截断时没有该行

#### Scenario: 超时与配置分离

- **WHEN** 配置 `startupTimeoutMs` / `diagnosticsWaitMs` / `initializeTimeoutMs`
- **THEN** 覆盖全局与默认值；`initializationOptions` 进 initialize 请求、`settings` 进 didChangeConfiguration / workspace/configuration 请求

#### Scenario: 关闭不得早于诊断收集

- **WHEN** 本次写入的诊断尚未收集完成
- **THEN** 不得因 LRU 淘汰或外部改动而关闭该文档；`didClose` 只发生在诊断汇总之后
