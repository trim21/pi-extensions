# claude-code-tools Specification

## Purpose

Claude Code 风格工具集（大写 `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` / `TodoWrite` / `AskUserQuestion`），聚合文件、搜索、shell 与 session 四组工具，与 opencode 风格工具集互斥（按预期只启用一套）。

## Requirements

### Requirement: 文件工具

读取、编辑、写入文件。

#### Scenario: Read 读取

- **WHEN** 读取文本文件
- **THEN** 返回文件内容，大文件截断并支持分段（`offset` / `limit`）；图片作为附件

#### Scenario: Edit 编辑

- **WHEN** 在文件中替换内容
- **THEN** 按匹配策略替换，自动处理 BOM 与行尾转换

#### Scenario: Write 写入

- **WHEN** 写入文件
- **THEN** 不存在则创建（自动建父目录），存在则覆盖；受写保护约束

### Requirement: Bash 沙箱执行

命令在 bwrap 沙箱内执行。

#### Scenario: 沙箱执行

- **WHEN** 执行 bash 命令
- **THEN** 命令在 bwrap 沙箱内运行（文件系统 + 网络隔离按模式生效）

### Requirement: 搜索工具

正则搜索与文件模式匹配。

#### Scenario: Grep 搜索

- **WHEN** 按正则搜索文件内容
- **THEN** 返回匹配结果（支持 `files_with_matches` / `content` / `count` 输出模式与行号）

#### Scenario: Glob 匹配

- **WHEN** 按 glob 模式查找文件
- **THEN** 返回匹配的文件路径

### Requirement: TodoWrite 任务列表

完整列表替换语义的任务列表工具。

#### Scenario: 完整替换

- **WHEN** 传入完整 todo 列表
- **THEN** 整体替换当前列表，支持状态（`pending` / `in_progress` / `completed`）与优先级

### Requirement: AskUserQuestion 提问

阻塞式提问工具。

#### Scenario: 提问并等待

- **WHEN** 提出一个问题或多个问题
- **THEN** 阻塞等待用户作答（支持单选/多选与自定义答案），答案返回给模型

## Implementation

入口 `src/claude-code/index.ts` 聚合四组工具：files（Read / Edit / Write）、search（Grep / Glob）、shell（Bash）、session（TodoWrite / AskUserQuestion）。

- **files**：与 opencode 风格共用匹配引擎（`src/opencode/edit-engine.ts`）与写保护（`src/lib/write-guard.ts`）；Read 状态创建与 session 恢复归 files 模块所有。
- **Grep**：`src/claude-code/grep.ts`，支持 `files_with_matches` / `content` / `count` 输出模式与行号。
- **Glob**：`src/claude-code/glob.ts`，文件模式匹配。
- **Bash**：与 opencode 风格 `bash` 共用 bwrap 沙箱实现（`src/bwrap/`）。
- **TodoWrite / AskUserQuestion**：`src/claude-code/session-tools.ts`，语义与 opencode 风格一致（完整替换 / 阻塞提问）。

涉及文件：`src/claude-code/`（index.ts / files.ts / grep.ts / glob.ts / shell.ts / session-tools.ts）。
