# Spec Delta

## MODIFIED Requirements

### Requirement: 工具注册门控

工具集仅在 AFT 二进制可用时注册。

#### Scenario: 二进制缺失不注册

- **WHEN** 无法解析到 AFT 二进制（缓存、npm 平台包、PATH、cargo、GitHub release 均不可用）
- **THEN** 不注册任何工具，session 开始时 notify warning

#### Scenario: 配置禁用不注册

- **WHEN** 用户级配置的 `enabled` 为 `false`
- **THEN** 不注册任何工具，也不产生缺失提示

### Requirement: 感知工具只读

outline / zoom / callgraph / search 为纯只读查询，MUST NOT 经过写保护审批。

#### Scenario: 符号大纲

- **WHEN** `aft_outline` 分析文件或目录
- **THEN** 文件返回符号大纲（签名 + 行号），目录默认返回扁平文件树（`files: false` 切换为符号大纲，30KB 截断）；目录遍历上限由引擎的 `walk_limit` 决定（当前 10000 文件）

#### Scenario: 符号查看

- **WHEN** `aft_zoom` 查看命名符号
- **THEN** 返回符号完整源码（代码按符号名解析，Markdown/HTML 按标题匹配；`callgraph: true` 附带同文件调用关系标注）

#### Scenario: 调用图查询

- **WHEN** `aft_callgraph` 查询调用关系
- **THEN** 按 `op`（callers / impact / call_tree / trace_to / trace_to_symbol / trace_data）返回结果；符号不存在时返回文本说明而非报错

#### Scenario: 调用图索引未就绪时内联等待

- **WHEN** 调用图存储正在冷构建或 watcher 触发的后台重建
- **THEN** 本次调用 SHALL 在配置的等待窗口内阻塞至构建完成并返回真实结果，而不是把"索引构建中"的提示返回给模型

#### Scenario: 等待窗口耗尽

- **WHEN** 构建在等待窗口内仍未就绪
- **THEN** 工具 SHALL 返回 `callgraph_building` 软结果文本（不抛错），且 guidelines MUST 指明稍后重试同一查询，而不是改走 grep + read 链条

#### Scenario: 等待窗口小于传输预算

- **WHEN** 设置等待窗口
- **THEN** 窗口 MUST 明显小于 aft-bridge 为 callgraph 命令配置的传输超时，避免客户端先超时并触发 bridge hang 升级

#### Scenario: 搜索注册门控

- **WHEN** 语义搜索未启用（`semantic_search: false`）
- **THEN** 不注册 `aft_search`

#### Scenario: 开关开启但后端未就绪

- **WHEN** `semantic_search: true` 而没有就绪的外部 embedding 后端
- **THEN** 不注册 `aft_search`，并在 session 开始时 notify 说明缺什么，而不是静默少一个工具

#### Scenario: 首次调用等待索引

- **WHEN** `aft_search` 已注册且语义索引仍在构建
- **THEN** 首次调用阻塞等待构建完成（至多 3600 秒，即 1 小时），避免返回部分结果

### Requirement: 不向模型暴露回滚与 OS 级文件操作

aft 引擎自带备份、undo 栈、命名 checkpoint 以及 `safety` / `delete` / `move` 命令，本仓库 MUST NOT 把这类恢复语义或 OS 级文件操作注册为模型可调用工具，也不得在 prompt 中引导模型依赖它们。

#### Scenario: 恢复类命令不注册

- **WHEN** aft 引擎暴露 `safety`（undo / history / checkpoint / restore / list）命令
- **THEN** 本仓库不注册对应工具；撤销与恢复由用户通过 git 完成

#### Scenario: 文件级移动与删除继续走 Bash

- **WHEN** 模型需要移动、重命名或删除文件
- **THEN** 使用 `Bash`（git 跟踪文件优先 `git mv` / `git rm`，使改动进入 review），本仓库不注册 `aft_move` 与 `aft_delete`

#### Scenario: 引擎侧备份不作为承诺

- **WHEN** 工具结果文本或既有 prompt 提到引擎自动备份
- **THEN** prompt MUST NOT 将其表述为模型可自助使用的回退手段，只需说明改动落在 git 工作区由用户 review

#### Scenario: 巡检工具不注册

- **WHEN** 模型需要 dead code / unused exports 结论
- **THEN** 本仓库不注册 `aft_inspect`：其结论依赖与 callgraph 同一个存储，且锁定的 0.59 引擎不报告尚未扫描的分类，空结果无法与"确实没有"区分

### Requirement: 工具清单与 prompt 文档一致

每个注册到 pi 的 aft 工具 SHALL 有同目录 `.md` guidelines 并在 `src/aft/index.ts` 完成注册；prompt 与注释中引用的工具名 MUST 指向实际已注册的工具，条件注册的工具 MUST 标明其注册条件。

#### Scenario: 引用不再悬空

- **WHEN** 任一 aft 工具的 description、guidelines 或模块注释提到另一个 aft 工具
- **THEN** 被提到的工具 SHALL 已在本仓库注册；未注册者（`aft_move` / `aft_delete` / `aft_safety` / `aft_inspect`）MUST NOT 出现在推荐路径中

#### Scenario: 条件注册的工具不被其它 prompt 引用

- **WHEN** 某工具只在特定配置下注册（`aft_search` 依赖语义搜索后端）
- **THEN** 其它工具的 guidelines MUST NOT 把模型指向它，避免默认配置下引用不存在的工具

#### Scenario: 不保留未接线的工具实现

- **WHEN** 某个工具的实现模块没有任何注册调用点
- **THEN** 其实现与测试 SHALL 一并移除，注释与文档 MUST NOT 再引用它（本次移除 `src/aft/ast-edit.ts` 与 `test/aft-ast-edit.test.ts`）

#### Scenario: guidelines 常驻注入

- **WHEN** 工具 guidelines 被注入 system prompt
- **THEN** 每份 MUST 保持与现有 aft `.md` 同量级的篇幅，只写调用契约与易错点
