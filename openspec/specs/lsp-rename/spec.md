# lsp-rename Specification

## Purpose

LSP 符号重命名工具：基于 prepareRename / rename 请求，按文件 + 行号 + 符号名定位（列号由工具计算），跨文件更新全部引用，并复用 claude-code 文件工具既有的写盘安全面、reads 记账与诊断反馈。

## Requirements

### Requirement: 定位参数

`lsp-rename` SHALL 以 `file_path`（必填，绝对或相对路径，相对与 `~` 前缀按调用 cwd 解析为绝对路径）、`line`（1-based，必填）、`symbol`（该行上的符号名，必填）、`new_name`（必填）定位要重命名的符号；`character`（1-based，可选）仅作同行同名歧义的消歧。列号由工具计算，不要求模型提供。

#### Scenario: 只给符号名

- **WHEN** 提供 `line` 与 `symbol`，未提供 `character`
- **THEN** 在该行按词边界枚举与 `symbol` 相同的出现位置作为候选，逐个探测

#### Scenario: 给出消歧列号

- **WHEN** 提供 `character`
- **THEN** 使用该列所在词的位置（转为 LSP 0-based）；该词与 `symbol` 不一致时报参数错误

#### Scenario: 该行没有目标符号

- **WHEN** 该行没有任何与 `symbol` 相同的词出现
- **THEN** 报"行 N 上找不到符号 X"，不发起 LSP 请求

#### Scenario: 非法参数

- **WHEN** `line` 或 `character` 不是正整数、`symbol` / `new_name` 为空，或解析后的 `file_path` 不存在
- **THEN** 报可定位的参数错误，不发起 LSP 请求

### Requirement: 同名歧义消解

工具 SHALL 对候选位置逐个发起 rename 请求并比较编辑集合，确保不会改错同名符号。

#### Scenario: 候选指向同一编辑集合

- **WHEN** 多个候选位置的 rename 结果完全一致
- **THEN** 视为同一符号的多次出现，执行一次重命名，结果中报告符号原名（placeholder）供核对

#### Scenario: 多个候选指向不同目标

- **WHEN** 多个候选位置的 rename 结果不一致（如同名的外部函数与局部变量）
- **THEN** 不执行任何修改，报错列出各候选（1-based 行列号 + placeholder），要求补 `character` 重试

#### Scenario: 无可 rename 目标

- **WHEN** 所有候选位置都不可 rename
- **THEN** 报"该位置不可重命名"，不修改任何文件

### Requirement: 跨文件引用更新

重命名 SHALL 基于 LSP `textDocument/rename` 返回的 WorkspaceEdit 更新全 workspace 的声明与引用。发起 rename 前 SHALL 先发送 `textDocument/references`（`includeDeclaration: true`）作为同步点——其响应到达即表示服务器完成项目加载；references 的结果不用于校验 rename 编辑（信任服务器，与编辑器行为一致）。

#### Scenario: 跨文件重命名

- **WHEN** 符号在其他文件中被引用
- **THEN** 所有受影响文件一并修改，工具结果列出每个文件的修改数

#### Scenario: 服务器不支持 rename

- **WHEN** 目标服务器没有 rename 能力，或 `prepareRename` 返回位置不可 rename
- **THEN** 报可定位的错误（指明服务器与位置），不修改任何文件

### Requirement: WorkspaceEdit 应用

工具 SHALL 只应用 text edit；在写入任何文件之前先在内存中完成全部受影响文件的新旧文本计算。

#### Scenario: documentChanges 与 changes 兼容

- **WHEN** 服务器返回 `documentChanges`（TextDocumentEdit）或 `changes` 形式的编辑
- **THEN** 两者都支持，同一文件的编辑按位置从后往前应用

#### Scenario: 文件级操作不支持

- **WHEN** WorkspaceEdit 含 create / rename / delete 文件级操作
- **THEN** 整体报"不支持"，不应用任何部分编辑

#### Scenario: 原子性

- **WHEN** 任一受影响文件在计算阶段无法读取或解析
- **THEN** 放弃整个重命名并报错，不落盘任何文件

### Requirement: 写盘安全与记账

写盘 SHALL 复用仓库既有写保护与记账语义。

#### Scenario: 路径级审批

- **WHEN** 任一受影响文件在 workspace（及 /tmp）之外
- **THEN** 写入前走路径级审批；headless 下直接拒绝

#### Scenario: 并发写保护

- **WHEN** 同一文件有其他写工具操作并发进行
- **THEN** 按 per-file mutation queue 串行执行，避免丢失更新

#### Scenario: reads 记账

- **WHEN** 重命名完成
- **THEN** 更新受影响文件的已读快照记账，模型无需重新 Read 即可继续 Edit 这些文件

### Requirement: 诊断反馈

重命名完成 SHALL 对每个受影响文件等待并附带 LSP 诊断。

#### Scenario: 写后诊断

- **WHEN** 全部文件写盘成功
- **THEN** 工具结果附带各文件的诊断摘要（与 Edit / Write 工具同格式）；诊断等待不改变重命名结果

### Requirement: 服务器选择

工具 SHALL 只向 `kind` 为 `language` 的 LSP 服务器发起 rename 请求。

#### Scenario: 只匹配 language 服务器

- **WHEN** 文件同时匹配 `language` 与 `linter` 类服务器
- **THEN** 只使用 `language` 类服务器；`linter` 类服务器不被唤醒

#### Scenario: 无可用服务器

- **WHEN** 文件没有任何可用的 `language` 类服务器
- **THEN** 报"无可用 LSP 服务器"的可定位错误，不静默失败
