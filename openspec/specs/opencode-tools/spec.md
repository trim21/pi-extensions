# opencode-tools Specification

## Purpose

opencode 风格工具集（小写 `read` / `edit` / `write` / `bash` / `todowrite` / `question`），一次加载全部注册，与 Claude Code 风格工具集互斥（按预期只启用一套）。

## Requirements

### Requirement: read 读取文件

读取文件内容，支持文本与图片。

#### Scenario: 文本文件读取

- **WHEN** 读取文本文件
- **THEN** 返回文件内容，输出截断到 2000 行或 64KB（先到为准）；大文件用 `offset` / `limit` 分段读取

#### Scenario: 图片读取

- **WHEN** 读取图片文件（jpg / png / gif / webp）
- **THEN** 图片作为附件发送（当前模型支持视觉时）

### Requirement: edit 编辑文件

按 opencode 的 schema 与匹配引擎编辑文件。

#### Scenario: 多策略匹配

- **WHEN** 在文件中查找待替换内容
- **THEN** 按顺序尝试匹配策略（精确、行尾空白容差、块锚定、空白规范化、缩进灵活、转义规范化、边界修剪、上下文感知、多次出现），第一个匹配成功即替换

#### Scenario: 编码规范化

- **WHEN** 编辑含 BOM 或 CRLF/LF 行尾的文件
- **THEN** 自动处理 BOM 与行尾转换，替换成功后恢复原格式

### Requirement: write 写入文件

创建或覆盖文件。

#### Scenario: 创建与覆盖

- **WHEN** 写入文件
- **THEN** 文件不存在则创建（自动建父目录），存在则覆盖；写入受写保护约束（workspace 边界）

### Requirement: bash 沙箱执行

命令在 bwrap 沙箱内执行。

#### Scenario: 沙箱执行命令

- **WHEN** 执行 bash 命令
- **THEN** 命令在 bwrap 沙箱内运行（文件系统 + 网络隔离按模式生效），内置默认超时

### Requirement: todowrite 任务列表

完整列表替换语义的任务列表工具。

#### Scenario: 完整替换

- **WHEN** 模型调用 `todowrite` 传入完整 todo 列表
- **THEN** 整体替换当前列表（无单条增删改动作）；状态支持 `pending` / `in_progress` / `completed` / `cancelled`，优先级支持 `high` / `medium` / `low`

#### Scenario: 持久化与渲染

- **WHEN** 调用 `todowrite`
- **THEN** 列表存入工具结果 `details.todos`，跟随会话分支自动恢复；以完整 markdown 列表渲染（pendant 面板自动展开）

### Requirement: question 阻塞提问

阻塞式提问工具，等待用户作答。

#### Scenario: 提问并等待

- **WHEN** 模型调用 `question` 提出一个问题或多个问题
- **THEN** 工具挂起等待用户作答（单选 / `multiple: true` 时多选），答案返回给模型；跳过的问题返回空数组

#### Scenario: 自定义答案

- **WHEN** 用户不选预设选项
- **THEN** 可通过 `Type your own answer.` 自由输入

## Implementation

入口 `src/opencode/index.ts` 聚合注册四组工具：files（read / edit / write，统一构建并共享 LSP service）、todo、question、bash。

- **read**：文本按 2000 行 / 64KB 截断（先到为准），支持 `offset` / `limit` 分段；图片（jpg / png / gif / webp）作为附件发送。
- **edit**：匹配引擎在 `src/opencode/edit-engine.ts`（核心 replacer 与 `replace()` 直接复制自 opencode），9 种匹配策略按顺序尝试、第一个成功即替换；自动处理 BOM、CRLF/LF 行尾转换与文件写入队列（`withFileMutationQueue`）；写入后报告 LSP 诊断。
- **write**：`guardWriteAccess` 过写保护后写入，自动创建父目录。
- **bash**：走 bwrap 沙箱执行（与 Claude Code 风格 `Bash` 共用 `src/bwrap/` 实现）。
- **todowrite**：完整列表替换语义，列表存 `details.todos` 随会话分支恢复，用 `details.pendant.markdown` 渲染（`src/lib/pendant.ts` 约定）。
- **question**：交互走 pi 内置 `ctx.ui.select` / `ctx.ui.input`，阻塞等用户作答。

涉及文件：`src/opencode/`（index.ts / files.ts / edit-engine.ts / bash.ts / todo.ts / question.ts）。
