# lsp-inspect Specification

## Purpose

只读 LSP 符号查询工具族：`lsp-find-definition`（定义跳转）、`lsp-find-reference`（引用查找）、`lsp-inspect`（hover 信息）。与 `lsp-rename` 共享定位与消歧语义，为模型提供 grep + read 之外的语义级代码感知能力。

## Requirements

### Requirement: 定位参数

三个工具 SHALL 共用与 `lsp-rename` 一致的定位参数：`file_path`（必填，绝对或相对路径，相对与 `~` 前缀按调用 cwd 解析为绝对路径）、`line`（1-based，必填）、`symbol`（该行上的符号名，必填）、`character`（1-based，可选，仅作同行同名歧义的消歧）。列号由工具按词边界枚举候选自行计算，不要求模型提供。

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

- **WHEN** `line` 或 `character` 不是正整数、`symbol` 为空，或解析后的 `file_path` 不存在
- **THEN** 报可定位的参数错误，不发起 LSP 请求

### Requirement: 同名歧义消解

工具 SHALL 对候选位置逐个发起查询并比较结果，确保查询的是模型预期的符号。

#### Scenario: 候选结果一致

- **WHEN** 多个候选位置的查询结果一致
- **THEN** 视为同一符号的多次出现，返回该结果

#### Scenario: 候选结果不一致

- **WHEN** 不同候选位置返回不同的查询结果
- **THEN** 报歧义错误，列出各候选的 1-based 行列号，提示补 `character` 重试，不返回部分结果

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

三个工具 SHALL NOT 修改任何文件或工作区状态；查询失败不产生副作用。

#### Scenario: 查询失败无副作用

- **WHEN** 请求超时、服务器报错或结果为空
- **THEN** 文件系统保持调用前状态

### Requirement: 多服务器分发与能力缺失

服务层 SHALL 仅向 `kind: "language"` 的 LSP 服务器发起查询，按配置顺序取第一个成功结果；全部服务器都不支持该方法时，报可定位的"不支持"错误。

#### Scenario: 首个服务器成功

- **WHEN** 配置的第一个 language 服务器成功应答
- **THEN** 直接采用该结果，不询问其余服务器

#### Scenario: 首个服务器不支持

- **WHEN** 第一个服务器对该方法返回 MethodNotFound
- **THEN** 尝试下一个服务器；全部不支持时报"无服务器支持该方法"的错误

#### Scenario: 没有 language 服务器

- **WHEN** 该文件类型没有匹配的 `kind: "language"` 服务器
- **THEN** 报可定位错误，提示检查 lsp.json 配置
