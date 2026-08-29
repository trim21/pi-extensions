# session-name Specification

## Purpose

根据会话的第一个 user prompt 自动生成显示名，便于在 `/resume` 与 `pi -r` 中区分会话；命名失败仅告警不阻塞，已有名字不被覆盖。

## Requirements

### Requirement: 自动命名

配置了命名模型时，把首条 user prompt 概括成短名。

#### Scenario: 模型生成名字

- **WHEN** 配置了 `sessionName.model` 且会话有首条 user prompt
- **THEN** 调用命名模型把 prompt 概括成短名，输出截断到 `maxLength`

#### Scenario: 恢复无名会话补名

- **WHEN** resume / fork 恢复一个无名字的会话
- **THEN** 从历史第一条 user 消息生成名字

### Requirement: 失败即告警

命名失败不阻塞、不产生错误名。

#### Scenario: 未配置或失败

- **WHEN** 未配置 `sessionName`、provider 不可解析或模型调用失败
- **THEN** 不设置名字，仅以 warning 通知

### Requirement: 不覆盖已有名字

用户设置的会话名不被自动命名覆盖。

#### Scenario: 已命名会话跳过

- **WHEN** 会话已通过 `--name` / `/name` 设置名字，或是恢复的已命名会话
- **THEN** 自动命名跳过，不改名

### Requirement: 非阻塞后台命名

命名在后台进行，不拖慢首轮回复。

#### Scenario: 后台命名

- **WHEN** 会话开始
- **THEN** 命名在后台进行，首轮回复不被拖慢；中途切换会话不会把名字写到错误的 session

## Implementation

入口 `src/session-name.ts`：监听会话初始化，首个 user prompt 到达后在后台异步命名（不阻塞首轮回复）。

- 配置了 `sessionName.model` 时调用命名模型（OpenAI 兼容 API，复用 `~/.pi/agent/models.json` 的 provider 配置）把 prompt 概括成短名，输出截断到 `maxLength`。
- 命名结果写入会话元数据；中途切换会话不会把名字写到错误的 session（按会话作用域写入）。
- 未配置 `sessionName`、provider 不可解析或模型调用失败时不设置名字，仅以 warning 通知。

涉及文件：`src/session-name.ts`。
