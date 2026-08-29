# talk Specification

## Purpose

不同 pi session（同一台机器）通过共享的 SQLite 邮箱互相发送消息、提问并等待回复；session 可见性由 group 决定，消息投递可靠（投递成功才消费），presence 不依赖心跳。

## Requirements

### Requirement: 消息投递

session 之间可发送消息并列出可见 session。

#### Scenario: 发送消息到指定 session

- **WHEN** 向某个 session id 发送纯文本消息（`talk-send`）
- **THEN** 消息进入邮箱，对端 session 按投递方式接收；`to` 只接受明确的 session id，不支持广播

#### Scenario: 列出可见 session

- **WHEN** 调用 `talk-list-sessions`
- **THEN** 返回可见 session 的 JSON 列表（`status` / `work_dir` / `id` / `name`，自己带 `self: true`），只列出同组成员（未入组时只有自己）

#### Scenario: 提问并等待

- **WHEN** 向某个 session 提问（`talk-ask`）
- **THEN** 阻塞等待回应（默认 30 分钟超时）；对方发来任何 `talk-send` 消息都会解除等待

### Requirement: 投递可靠性

信件只在成功交给 `sendMessage` 后才从 inbox 删除，投递失败保留重试。

#### Scenario: 投递失败不丢信

- **WHEN** `sendMessage` 投递失败（或吞异常）
- **THEN** 信件保留在 inbox，下次投递重试，不静默丢失

### Requirement: presence 判定

session 的在线状态由 `offline` 标志与进程存活判定，不依赖心跳。

#### Scenario: 进程存活即 live

- **WHEN** session 未标记 offline 且对应进程存活
- **THEN** 该 session 显示为 live（`idle` / `working` / `waiting-talk-message`）

#### Scenario: pid 回卷不误判

- **WHEN** 判定进程存活时校验进程启动时间（`/proc/<pid>/stat`）
- **THEN** pid 回卷复用旧 pid 的场景不被误判为存活

### Requirement: 双向 ask 仲裁

两个 session 同时互相 `talk-ask` 时，按信件 `ts` 字段仲裁。

#### Scenario: 先 ask 者主导

- **WHEN** 两个 ask 的 `ts` 不同
- **THEN** 先 ask（ts 较小）的一方继续等待，后 ask 的一方让位并先回复对方

#### Scenario: 同毫秒碰撞兜底

- **WHEN** 两个 ask 的 `ts` 相同
- **THEN** 用 `session dir + session id` 字符串比较决定主导方，结论双方对称

### Requirement: 消息安全限制

纯文本消息有大小与速率限制，防止消息环与滥用。

#### Scenario: 超限消息被拒

- **WHEN** 消息超过 32KB、10 秒内重复、30 秒内超过 8 条或积压超过 50 条
- **THEN** 消息被拒绝（防环与限速）

#### Scenario: 来源标注

- **WHEN** 消息来自另一个 pi session
- **THEN** 投递时标注来源（非用户消息）

### Requirement: group 可见性

session 的可见性完全由 group 决定。

#### Scenario: 组内互见

- **WHEN** 多个 session 加入同一 group
- **THEN** 它们互相可见且只看到彼此（组外 session 不可见）

#### Scenario: 未入组只见自己

- **WHEN** session 不在任何 group
- **THEN** 只能看到自己

#### Scenario: 建组/入组/离组即时生效

- **WHEN** 通过 `/talk-group-*` 命令建组、入组、离组
- **THEN** 成员关系实时生效，无需重启

### Requirement: 定期清理

回收已死 session 的记录与过期邮箱数据。

#### Scenario: 已死 session 超时回收

- **WHEN** 进程已死、最后活跃超过 24h 且无未投递 mail
- **THEN** 记录被定期 sweep（30 分钟一次）回收；有 mail 的保留 30 天

#### Scenario: 存活进程永不回收

- **WHEN** 进程仍存活
- **THEN** 对应记录永不回收

## Implementation

三层架构（`src/talk/`）：

```
storage.ts   —— 存储层：TalkStorage 接口 + SqliteTalkStorage（node:sqlite，零 npm 依赖）
core.ts      —— talk 核心：registry / mailbox / group / policy / format + TalkCore 协调器，
               只依赖存储层，通过回调 yield 投递 / 通知
index.ts     —— pi adapter：把 core 接到 pi 的 sendMessage / 生命周期事件 / 工具注册
```

关键机制：

- **投递可靠**：信件只在成功交给 `sendMessage` 后才从 inbox 删除，投递失败保留重试——不因 `sendMessage` 吞异常而静默丢信。
- **presence 不靠心跳**：`offline` 标志 + 进程 pid 存活判定；pid 存活时校验 `/proc/<pid>/stat` 启动时间，排除 pid 回卷复用误判。
- **双向 ask 仲裁**：按信件 `ts` 字段仲裁（先 ask 者主导继续等，后 ask 者让位先回复）；同毫秒碰撞用 `session dir + session id` 字符串比较兜底，双方读到同一对值结论对称。
- **安全**：纯文本 ≤32KB、10s 去重、30s 限速 8 条、50 积压上限；投递标注来源。
- **存储校验**：所有从存储读出的值经 typebox schema 校验，损坏 / 伪造数据被拒绝。
- **定期清理**：进程存活永不回收；进程已死且最后活跃超 24h 且无未投递 mail 的记录 30 分钟 sweep 一次，有 mail 保留 30 天。
- **group**：带 uuid 的私有房间，成员关系存共享 DB，实时生效；一个 session 只能属于一个 group。

涉及文件：`src/talk/`（storage.ts / core.ts / index.ts）。
