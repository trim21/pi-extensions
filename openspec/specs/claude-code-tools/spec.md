# claude-code-tools Specification

## Purpose

Claude Code 风格工具集（大写 `Read` / `Edit` / `Write` / `Bash` / `Grep` / `Glob` / `TodoWrite` / `AskUserQuestion`，外加 LSP 专属的 `lsp-rename` / `lsp-find-definition` / `lsp-find-reference` / `lsp-inspect`），聚合文件、搜索、shell 与 session 四组工具（LSP 工具族随文件组注册），与 opencode 风格工具集互斥（按预期只启用一套）。

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

命令在 bwrap 沙箱内执行。工具在保持现有文本输出、沙箱状态提示与抛错语义的同时 MUST 声明输出结构，并在命令执行结束（含非零退出、超时、中止）时给出与该结构匹配的载荷（`structuredResult`）：

```ts
{
  exitCode: number | null;
  output: string;
}
```

- 载荷 MUST 只有这两个字段：MUST NOT 出现 `ok`、`status` 或其他成败/状态标志。
- `exitCode` MUST 是命令的退出码；命令被信号终止（超时、用户中止）或没有退出码时 MUST 为 `null`（原因由文本与 `details` 交代，脚本不需要区分）。
- `output` MUST 是命令的**完整**输出（stdout 与 stderr 已合并）：即使模型看到的文本因超出上限被截断，载荷 MUST 给出全文（截断时从落盘文件读回）。MUST NOT 混入工具自己追加的截断提示、退出码状态行或沙箱状态说明。
- 非零退出码 MUST 是成功的结构化结果，MUST NOT 用调用失败表达——命令跑了、只是返回非零，这是脚本要据以分支的正常结果，与今天的工具语义一致；载荷里 MUST NOT 另有成败标志。
- 工具自己出错（沙箱起不来等）仍然抛错，由总线转成失败结果。

#### Scenario: 沙箱执行

- **WHEN** 执行 bash 命令
- **THEN** 命令在 bwrap 沙箱内运行（文件系统 + 网络隔离按模式生效），文本输出与今天一致，同时给出 `{ exitCode, output }` 载荷

#### Scenario: 非零退出码是正常结果

- **WHEN** 命令以非零退出码结束（如 `rg` 没匹配到任何东西退出 1）
- **THEN** 载荷的 `exitCode` 就是该退出码，调用本身是成功的，脚本可以据它分支

#### Scenario: 输出被截断时载荷仍是全文

- **WHEN** 命令输出超过上限（文本被截断、完整输出落到文件）
- **THEN** 文本与今天一致（截断内容 + 截断提示），而载荷的 `output` 是完整输出，且不含工具追加的任何提示文本

#### Scenario: 超时与中止

- **WHEN** 命令超过超时上限或被用户中止
- **THEN** 载荷的 `exitCode` 为 `null`、`output` 为已捕获的部分输出（超时与中止的区别在文本与 `details` 里）；文本与沙箱状态提示与今天一致

#### Scenario: 声明结构不改变既有输出

- **WHEN** 比较改动前后的同一条命令结果
- **THEN** 文本、`details`（含 `truncation` / `fullOutputPath`）与失败时的抛错行为都逐字/逐语义不变

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
- **THEN** 整体替换当前列表；每项含 `content` / `status`（`pending` / `in_progress` / `completed`）/ `activeForm`（无优先级字段）

### Requirement: AskUserQuestion 提问

阻塞式提问工具。

#### Scenario: 提问并等待

- **WHEN** 提出一个问题或多个问题
- **THEN** 阻塞等待用户作答（支持单选/多选与自定义答案），答案返回给模型

## Implementation

入口 `src/claude-code/index.ts` 聚合四组工具：files（Read / Edit / Write）、search（Grep / Glob，`search.ts` 聚合 `grep.ts` / `glob.ts`）、shell（Bash）、session（TodoWrite / AskUserQuestion）。

- **files**：Edit 的匹配在 `src/claude-code/edit-match.ts`（精确匹配，Claude Code 语义）；写保护经 `src/lib/write-guard.ts` 与 opencode 侧共享，审批展示的 diff 由本工具算好的「变更前后完整内容」直接渲染（见 `openspec/specs/write-guard/spec.md`）；Read 状态创建与 session 恢复归 files 模块所有。
- **LSP 工具族**：`lsp-rename` / `lsp-find-definition` / `lsp-find-reference` / `lsp-inspect` 由 files 模块的 LSP manager 在存在 enabled 服务器时注册（见 `openspec/specs/lsp/spec.md`），实现位于 `src/lib/lsp/`。
- **Grep**：`src/claude-code/grep.ts`，支持 `files_with_matches` / `content` / `count` 输出模式与行号。
- **Glob**：`src/claude-code/glob.ts`，文件模式匹配。
- **Bash**：与 opencode 风格 `bash` 共用 bwrap 沙箱实现（`src/bwrap/`）。
- **TodoWrite / AskUserQuestion**：`src/claude-code/session-tools.ts`，语义与 opencode 风格一致（完整替换 / 阻塞提问）。

涉及文件：`src/claude-code/`（index.ts / common.ts / files.ts / edit-utils.ts / search.ts / grep.ts / glob.ts / shell.ts / session-tools.ts）。
