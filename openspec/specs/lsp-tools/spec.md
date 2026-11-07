# lsp-tools Specification

## Purpose

LSP 符号工具族：`lsp-rename` 跨文件更新引用，`lsp-find-definition` / `lsp-find-reference` / `lsp-inspect` 提供只读的定义、引用与 hover 查询。四者共用一套「文件 + 行号 + 符号名」的定位与同名消歧语义，为模型提供 grep + read 之外的语义级代码感知能力。服务层（配置、启动、诊断、文件事件同步）由 `openspec/specs/lsp/spec.md` 拥有。

## Requirements

### Requirement: 定位参数

四个工具 SHALL 共用同一套定位参数：`file_path`（必填，绝对或相对路径，相对与 `~` 前缀按调用 cwd 解析为绝对路径）、`line`（1-based，必填）、`symbol`（该行上的符号名，必填）、`character`（1-based，可选，仅作同行同名歧义的消歧）；`lsp-rename` 另需 `new_name`（必填）。列号由工具按词边界枚举候选自行计算，不要求模型提供。

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

- **WHEN** `line` 或 `character` 不是正整数、`symbol` 为空、`lsp-rename` 的 `new_name` 为空，或解析后的 `file_path` 不存在
- **THEN** 报可定位的参数错误，不发起 LSP 请求

### Requirement: 同名歧义消解

工具 SHALL 对候选位置逐个发起请求并比较结果，确保操作的是模型预期的符号：读工具比较查询结果，`lsp-rename` 比较编辑集合。

#### Scenario: 候选指向同一结果

- **WHEN** 多个候选位置的查询结果一致（`lsp-rename` 为 rename 结果完全一致）
- **THEN** 视为同一符号的多次出现，返回该结果；`lsp-rename` 执行一次重命名，并在结果中报告符号原名（placeholder）供核对

#### Scenario: 多个候选指向不同目标

- **WHEN** 不同候选位置返回不同的结果（`lsp-rename` 如同名的外部函数与局部变量）
- **THEN** 报歧义错误，列出各候选的 1-based 行列号（`lsp-rename` 另给 placeholder），提示补 `character` 重试，不返回部分结果、不修改任何文件

#### Scenario: 无可 rename 目标

- **WHEN** 所有候选位置都不可 rename
- **THEN** 报"该位置不可重命名"，不修改任何文件

### Requirement: lsp-find-definition 返回定义位置

`lsp-find-definition` SHALL 发起 `textDocument/definition` 请求，把返回的 Location / LocationLink 归一化为位置列表，每项给出 1-based 的 `path:line:col` 与该行源码片段。

成功结果 SHALL 同时带 `structuredResult`，载荷为 `{ text, serverID, locations }`：`text` MUST 与该次调用的工具输出逐字一致；`serverID` MUST 是回答这次查询的语言服务器 id；`locations` MUST 是查询到的全部位置，每项 `{ path, line, character }`，行列号 MUST 是 1-based（与文本里的 `path:line:col`、与这三个工具自己的 `line` / `character` 参数同一套口径，脚本拿到就能回喂给下一次查询），顺序 MUST 与文本一致。空结果 MUST 是成功结果（`locations` 为空数组），MUST NOT 用失败表达。工具的文本输出、`details` 与错误抛出行为 MUST 保持不变。

#### Scenario: 单一定义

- **WHEN** 服务器返回一个定义位置
- **THEN** 输出该项的路径、1-based 行列号与行内容片段

#### Scenario: 多个定义

- **WHEN** 服务器返回多个定义位置（接口、重载、部分实现等）
- **THEN** 逐一列出全部位置

#### Scenario: 无定义信息

- **WHEN** 服务器返回空结果
- **THEN** 如实报告该符号没有定义信息，不视为错误

#### Scenario: 定义位置进结构化载荷

- **WHEN** 服务器返回多个定义位置
- **THEN** 载荷的 `locations` 给出全部位置的绝对路径与 1-based 行列号（顺序与文本一致），并带上回答查询的 `serverID`

### Requirement: lsp-find-reference 返回引用列表

`lsp-find-reference` SHALL 发起 `textDocument/references` 请求（包含符号声明处，与 `lsp-rename` 的覆盖校验口径一致），按文件分组输出 1-based 位置与行内容片段，并附引用总数与文件数。

成功结果 SHALL 同时带 `structuredResult`，载荷为 `{ text, serverID, locations }`，字段语义与 `lsp-find-definition` 一致（1-based、绝对路径、顺序与文本一致），但 `locations` MUST 给出查询到的**全部**引用位置：文本为模型上下文做的截断（每文件 10 条、最多 30 个文件）MUST NOT 传导到载荷——载荷是给程序用的数据，截断是渲染的事。空结果 MUST 是成功结果（`locations` 为空数组）。工具的文本输出、`details` 与错误抛出行为 MUST 保持不变。

#### Scenario: 跨文件引用

- **WHEN** 引用分布在多个文件
- **THEN** 按文件分组列出各引用的位置与行片段，附总数汇总

#### Scenario: 输出截断

- **WHEN** 引用数量超出输出上限
- **THEN** 对行片段与文件列表做截断，并明确标注剩余数量，不静默丢弃

#### Scenario: 无引用

- **WHEN** 服务器返回空结果
- **THEN** 如实报告该符号没有引用，不视为错误

#### Scenario: 载荷不跟着文本截断

- **WHEN** 引用数量超出文本的输出上限（例如同一文件里 12 条引用）
- **THEN** 文本按上限标注剩余数量，而载荷的 `locations` 仍给出全部 12 条

### Requirement: lsp-inspect 透传 hover 信息

`lsp-inspect` SHALL 发起 `textDocument/hover` 请求，把服务器返回的 hover 内容原样透传给模型（仅做结构格式化，如 MarkedString 数组转 code fence，不改写内容本身）。

成功结果 SHALL 同时带 `structuredResult`，载荷为 `{ text, serverID }`：`text` MUST 与该次调用的工具输出逐字一致（hover 内容是服务器给的异构结构，载荷不重新建模它），`serverID` MUST 是回答这次查询的语言服务器 id。没有 hover 信息 MUST 是成功结果（`text` 说明没有 hover，`serverID` 照给）。工具的文本输出、`details` 与错误抛出行为 MUST 保持不变。

#### Scenario: 有 hover 信息

- **WHEN** 服务器返回 hover 内容
- **THEN** 原样输出内容（类型签名、文档等）

#### Scenario: 无 hover 信息

- **WHEN** 服务器返回空结果
- **THEN** 如实报告该位置没有 hover 信息，不视为错误

#### Scenario: hover 结果带回答的服务器

- **WHEN** 服务器返回 hover 内容
- **THEN** 载荷给出与工具输出一致的 `text` 与回答这次查询的 `serverID`

### Requirement: 只读保证

三个读工具（`lsp-find-definition` / `lsp-find-reference` / `lsp-inspect`）SHALL NOT 修改任何文件或工作区状态；查询失败不产生副作用。

#### Scenario: 查询失败无副作用

- **WHEN** 请求超时、服务器报错或结果为空
- **THEN** 文件系统保持调用前状态

### Requirement: 跨文件引用更新

重命名 SHALL 基于 LSP `textDocument/rename` 返回的 WorkspaceEdit 更新全 workspace 的声明与引用。LSP 没有标准化的"索引完成"信号，服务器可能在项目加载完成前就回答，因此发起 rename 前 SHALL 先发送 `textDocument/references`（`includeDeclaration: true`）并等待其**文件集合收敛**（连续多次采样一致，且持续一致超过稳定下限；就绪未证实时下限更长），再做双向一致校验：references 报告的文件必须都被 rename edit 覆盖（missing），rename 触及的文件也必须都在已收敛的 references 集合内（extra）。不一致时不得写盘——缺失说明索引落后，多余说明索引仍在增长、rename 结果本身不可信（回到 references 轮询重新收敛后复检，预算耗尽才放弃）。服务器完全不支持 references（MethodNotFound）时跳过整套校验，信任服务器，与编辑器行为一致。

#### Scenario: 跨文件重命名

- **WHEN** 符号在其他文件中被引用，且 references 集合已收敛、与 rename edit 双向一致
- **THEN** 所有受影响文件一并修改，工具结果列出每个文件的修改数

#### Scenario: 残缺答案不算收敛

- **WHEN** 服务器索引仍在加载，references 只覆盖已发现的部分文件
- **THEN** 残缺血缘即使连续多次一致也不接受——文件集合须持续一致超过稳定下限才视为收敛；预算内未达标时报可重试的不完整错误，不写盘

#### Scenario: 覆盖校验拦截漏改

- **WHEN** references 报告的文件未被 rename edit 覆盖，或在预算耗尽时 rename 触及了 references 未报告的文件
- **THEN** 报可定位的不完整错误（列出缺失 / 多余的文件），不修改任何文件，并提示服务器索引可能仍在加载、稍后重试

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

### Requirement: 服务器选择与能力缺失

四类符号请求 SHALL 按配置顺序取第一个成功的结果；服务器对该方法返回 MethodNotFound 时 MUST 尝试下一个，全部不支持时报"无服务器支持该方法"。符号级请求 MUST 只使用 `kind: language` 的服务器（过滤由服务层执行，见 `openspec/specs/lsp/spec.md` 的「符号级请求按服务器类型过滤」），`linter` 类服务器 MUST NOT 因此被唤醒。

#### Scenario: 首个服务器成功

- **WHEN** 配置的第一个 language 服务器成功应答
- **THEN** 直接采用该结果，不询问其余服务器

#### Scenario: 首个服务器不支持

- **WHEN** 第一个服务器对该方法返回 MethodNotFound
- **THEN** 尝试下一个服务器；全部不支持时报"无服务器支持该方法"的错误

#### Scenario: 只匹配 language 服务器

- **WHEN** 文件同时匹配 `language` 与 `linter` 类服务器
- **THEN** 只使用 `language` 类服务器；`linter` 类服务器不被唤醒

#### Scenario: 没有 language 服务器

- **WHEN** 该文件类型没有匹配的 `kind: "language"` 服务器
- **THEN** 报可定位错误（提示检查 lsp.json 配置 / 无可用 LSP 服务器），不静默失败

## Implementation

实现位于 `src/lib/lsp/` 的 `inspect-tool.ts`（`lsp-find-definition` / `lsp-find-reference` / `lsp-inspect`，schema 在 `inspect-schemas.ts`）与 `rename-tool.ts` / `rename.ts`（`lsp-rename`）。四个工具由选中的文件 IO 工具集（`src/claude-code/files.ts` / `src/opencode/files.ts`）在 LSP manager 的 `onEnabled` 回调里注册，两套工具集共用同一份实现；`lsp-rename` 的写盘复用该工具集的写盘安全面与 reads 记账。
