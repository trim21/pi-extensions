# spawn-agent Specification

## Purpose

在当前 pi 进程内创建隔离的子 agent session 执行任务，子 agent 的清单、模型与工具由用户级配置声明；未声明工具时子 agent 只读，无法执行写入或任意命令。

## Requirements

### Requirement: 子 agent 清单

子 agent 从用户级 markdown 目录加载，增量式声明。

#### Scenario: 从 markdown 加载

- **WHEN** 读取 `~/.pi/agent/agents/*.md`
- **THEN** 解析 YAML frontmatter（`name` / `description` / `tools` / `provider` / `model` / `thinkingLevel`）+ 正文作为 system prompt；校验失败的 md 被跳过

#### Scenario: 模型与工具解析

- **WHEN** 解析子 agent 的模型与工具
- **THEN** 按 frontmatter > `spawn-agent.json` 全局默认 > pi `settings.json` 默认的顺序解析

### Requirement: 只读默认

未声明工具的子 agent 只能读取。

#### Scenario: 无 tools 声明时只读

- **WHEN** 子 agent 的 frontmatter 未声明 `tools`
- **THEN** 子 agent 只有只读工具（read / grep / find / ls），无 bash / write / edit

#### Scenario: 声明工具映射增强实现

- **WHEN** 子 agent 声明了 `read` / `edit` / `write` / `bash` 或大写风格工具
- **THEN** 映射到本仓库的增强实现（bash 自动带 bwrap 沙箱）

### Requirement: 执行与返回

子 agent 以任务 prompt 启动，阻塞到完成并返回结果。

#### Scenario: 执行任务

- **WHEN** 调用 `spawn-agent`（`agent` + `task` 参数）
- **THEN** 创建隔离 session 执行任务，阻塞到本轮完成；结果返回最后一个 assistant 文本块

#### Scenario: 输出截断

- **WHEN** 结果超过 50KB
- **THEN** 截断并注明，全量消息保留在 details

#### Scenario: 进度可见

- **WHEN** 子 agent 运行中
- **THEN** 通过 `onUpdate` 滚动展示进度（工具调用合并、文本块摘要、usage 实时显示）

### Requirement: 错误与中止

未知 agent、子 agent 失败与父进程中止有明确契约。

#### Scenario: 未知 agent

- **WHEN** 指定的 agent 不在清单中
- **THEN** 返回错误并列出可用 agent

#### Scenario: 子 agent 失败

- **WHEN** 子 agent 退出码非零或 stopReason 为 error / aborted
- **THEN** 返回错误，附带子 agent 的最终输出（`output:` 分行）与 stderr 尾部

#### Scenario: 父进程中止

- **WHEN** 父调用被中止
- **THEN** 子 session 被 abort，结果标记为中止

## Implementation

`src/spawn-agent.ts` 通过 pi SDK 的 `createAgentSession` 在**当前进程内**创建隔离 session（`SessionManager.inMemory`，非独立进程），`session.prompt("Task: " + task)` 阻塞到本轮 settle；session 内存态、不持久化。

- **agent 清单**：`src/spawn-agent-agents.ts` 从 `~/.pi/agent/agents/*.md` 加载（仅用户级），YAML frontmatter（`name` / `description` / `tools` / `provider` / `model` / `thinkingLevel`）+ 正文作 system prompt；校验失败的 md 跳过；模型名列表启动时注入 `promptGuidelines`，改文件需 `/reload`。
- **模型 / 工具解析**：frontmatter > `spawn-agent.json` > pi `settings.json` 默认。
- **工具映射**：frontmatter 声明工具时映射到本仓库增强实现——`read/edit/write/bash` → opencode（bash 自动带 bwrap 沙箱），`Grep/Glob/Read/Edit/Write` → claude-code；每个扩展文件只加载一次；未声明 `tools` 时子 agent 只读。
- **输出**：结果截断 50KB（超出注明并保留全量消息在 details）；details 含 `messages`、`stderr`、`usage`、`model`、`stopReason`、`exitCode` 与折叠面板。
- **中止**：父 signal → `session.abort()`，`stopReason ??= "aborted"`，exitCode 由 stopReason 推导。

涉及文件：`src/spawn-agent.ts`、`src/spawn-agent-agents.ts`。
