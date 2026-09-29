# Spec Delta

## ADDED Requirements

### Requirement: 项目根取自会话工作目录

AFT bridge 的项目根 SHALL 是当前会话的工作目录，而不是 pi 进程的启动目录；bridge 创建、用户级与项目级配置读取、工具取 bridge 与路径解析 MUST 都基于同一个项目根。

#### Scenario: 会话工作目录与进程启动目录不一致

- **WHEN** pi 进程在目录 A 启动，当前会话的工作目录是 B（A ≠ B）
- **THEN** AFT bridge SHALL 以 B 作为项目根启动，引擎按 B 建立索引与调用图存储，而不是把 A（如用户家目录）当作项目根并自动关闭语义搜索与调用图

#### Scenario: 进程启动目录与会话工作目录一致

- **WHEN** 会话工作目录与 pi 进程启动目录相同
- **THEN** 项目根仍为该目录，行为与既有实现一致

#### Scenario: 取 bridge 用同一项目根

- **WHEN** 工具执行时向 bridge 池索取连接
- **THEN** 使用的项目根 SHALL 与创建该 bridge 状态时记录的项目根一致，MUST NOT 另存或重新推导一份路径基准

### Requirement: 相对路径在扩展侧解析后转发

`aft_outline` 的 target 参数 SHALL 在扩展侧按会话工作目录解析为绝对路径后再转发给引擎，无论目标是文件还是目录；引擎侧 MUST NOT 需要按自己的项目根推导相对路径。

#### Scenario: 目录模式的相对 target

- **WHEN** `aft_outline` 收到相对目录 target（如 `src/codemode`）且处于文件树模式
- **THEN** 转发给引擎的 SHALL 是相对会话工作目录解析后的绝对路径，引擎返回该目录的文件树而不是 `directory not found`

#### Scenario: 文件模式的相对 target

- **WHEN** `aft_outline` 收到相对文件 target
- **THEN** 同样转发解析后的绝对路径，行为与既有实现一致

#### Scenario: 会话工作目录之外的项目根不受相对路径影响

- **WHEN** 引擎的项目根与会话工作目录不同（例如引擎侧另有其根）
- **THEN** 相对路径仍按会话工作目录解析，结果不受引擎项目根影响
