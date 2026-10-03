# aft Specification

## Purpose

基于常驻 Rust bridge 的代码分析工具集：感知工具（outline / zoom / callgraph / search）只读地解析符号与调用关系；AFT 二进制缺失时不注册工具。

## Requirements

### Requirement: 工具注册门控

工具集仅在 AFT 二进制可用时注册。

#### Scenario: 二进制缺失不注册

- **WHEN** 无法解析到 AFT 二进制（缓存、npm 平台包、PATH、cargo、GitHub release 均不可用）
- **THEN** 不注册任何工具，session 开始时 notify error

### Requirement: 项目根取自会话工作目录

AFT bridge 的项目根 SHALL 是当前会话的工作目录，而不是 pi 进程的启动目录；bridge 创建、用户级与项目级配置读取、工具取 bridge 与路径解析 MUST 都基于同一个项目根。

#### Scenario: 会话工作目录与进程启动目录不一致

- **WHEN** pi 进程在目录 A 启动，当前会话的工作目录是 B（A ≠ B）
- **THEN** AFT bridge SHALL 以 B 作为项目根启动，引擎按 B 建立索引与调用图存储，而不是把 A（如用户家目录）当作项目根并自动关闭语义搜索与调用图

#### Scenario: 进程启动目录与会话工作目录一致

- **WHEN** 会话工作目录与 pi 进程启动目录相同
- **THEN** 项目根仍为该目录，行为与既有实现一致

#### Scenario: 取 bridge 用同一项目根

- **WHEN** 工具执行时向 bridge 池索取连接
- **THEN** 使用的项目根 SHALL 与创建该 bridge 状态时记录的项目根一致，MUST NOT 另存或重新推导一份路径基准

### Requirement: 感知工具只读

outline / zoom / callgraph / search 为纯只读查询，MUST NOT 经过写保护审批。

#### Scenario: 符号大纲

- **WHEN** `aft_outline` 分析文件或目录
- **THEN** 文件返回符号大纲（签名 + 行号），目录默认返回扁平文件树（`files: false` 切换为符号大纲，30KB 截断）；目录递归上限 200 文件

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

### Requirement: 相对路径在扩展侧解析后转发

`aft_outline` 的 target 参数 SHALL 在扩展侧按会话工作目录解析为绝对路径后再转发给引擎，无论目标是文件还是目录；引擎侧 MUST NOT 需要按自己的项目根推导相对路径。

#### Scenario: 目录模式的相对 target

- **WHEN** `aft_outline` 收到相对目录 target（如 `src/codemode`）且处于文件树模式
- **THEN** 转发给引擎的 SHALL 是相对会话工作目录解析后的绝对路径，引擎返回该目录的文件树而不是 `directory not found`

#### Scenario: 文件模式的相对 target

- **WHEN** `aft_outline` 收到相对文件 target
- **THEN** 同样转发解析后的绝对路径，行为与既有实现一致

#### Scenario: 会话工作目录之外的项目根不受相对路径影响

- **WHEN** 引擎的项目根与会话工作目录不同（例如引擎侧另有其根）
- **THEN** 相对路径仍按会话工作目录解析，结果不受引擎项目根影响

### Requirement: 语义搜索只使用外部 embedding 后端

`aft_search` 的 embedding 计算 MUST 走外部 HTTP 后端（`openai_compatible` 或 `ollama`）；引擎默认的本地 ONNX `fastembed` 后端 MUST NOT 采用（内网镜像不提供 ONNX Runtime）。

#### Scenario: 后端类型决定注册

- **WHEN** `semantic_search: true` 且 `semantic.backend` 缺省或为 `fastembed`
- **THEN** 不注册 `aft_search`

#### Scenario: 外部后端就绪即注册

- **WHEN** `semantic.backend` 为 `openai_compatible` 或 `ollama` 且给出非空 `semantic.base_url`
- **THEN** 注册 `aft_search`，尾部斜杠在判定前被忽略

#### Scenario: 密钥由配置文件提供、扩展负责送达

- **WHEN** 用户在用户级 aft.jsonc 配了 `semantic.api_key`
- **THEN** 扩展把该值注入 aft 子进程的环境变量；用户未指定 `semantic.api_key_env` 时，扩展还以用户级 config tier 追加一个固定的内部变量名，使 aft 知道去读哪个变量

#### Scenario: 用户指定变量名时以其为准

- **WHEN** 配置给出 `semantic.api_key_env`
- **THEN** 值注入到该变量名下且不追加额外 config tier；只给 `api_key_env` 而不给 `api_key` 时扩展不注入任何值，由 aft 自行读取 shell 里的同名变量

#### Scenario: 无鉴权端点

- **WHEN** 既未配 `api_key` 也未配 `api_key_env`
- **THEN** `base_url` 就绪即注册 `aft_search`，且不注入任何凭据

#### Scenario: 密钥不外泄

- **WHEN** 扩展写日志、抛错或渲染 pendant
- **THEN** MUST NOT 出现密钥值；传给引擎的 config tier 中只允许出现变量名

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
- **THEN** 本仓库不注册 `aft_inspect`：其结论依赖与 callgraph 同一个存储，且锁定的 0.53 引擎不报告尚未扫描的分类，空结果无法与"确实没有"区分

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

### Requirement: 感知工具的结构化结果

四个感知工具（`aft_outline` / `aft_zoom` / `aft_callgraph` / `aft_search`）的成功结果 MUST 带 `structuredResult`，其载荷 MUST 是引擎响应自身的字段（去掉 envelope 的 request id）外加一个 `text`（与工具输出一致的渲染文本）。载荷 MUST 原样透传引擎字段：MUST NOT 丢弃脚本可能用得上的字段，MUST NOT 把引擎响应重新映射成另一套自定义形状。

声明的 schema MUST 宽松：引擎字段一律可选且允许额外字段，因为引擎是外部依赖，其响应会新增、改名或在预算耗尽时省略字段；把字段声明成必需会让引擎的版本变化把工具调用变成失败。宽松只针对字段的在场，MUST NOT 放宽类型校验：`text` MUST 是必需的字符串。

软失败（`symbol_not_found`、`callgraph_building`、`search_lanes_unavailable` 等引擎给出否定答案的码）MUST 保持「工具执行成功」的语义：载荷保留引擎的 `success: false` 与 `code`，脚本据 `code` 分支；MUST NOT 因此把它变成调用失败。工具的文本输出、`details` 与错误抛出行为 MUST 保持不变。

#### Scenario: outline 的文件条目

- **WHEN** `aft_outline` 以 files 模式分析目录
- **THEN** 载荷带引擎返回的 `files` 条目（`path` / `language` / `symbols` / `lines`）与截断标记，外加与工具输出一致的 `text`

#### Scenario: zoom 的符号与注解

- **WHEN** `aft_zoom` 查看一个符号
- **THEN** 载荷带 `name` / `kind` / `range` / `content` / `context_before` / `context_after` / `annotations`（`calls_out` / `called_by`）

#### Scenario: callgraph 按 op 取字段

- **WHEN** `aft_callgraph` 以任一 `op` 查询
- **THEN** 载荷带该 op 的引擎字段（`callers` / `children` / `paths` / `hops` / `total_*` / `truncated` 等）与 `text`，脚本按自己传入的 `op` 取用

#### Scenario: search 的命中列表

- **WHEN** `aft_search` 返回命中
- **THEN** 载荷带引擎的 `results` 条目（符号命中与降级时的 grep 行两种形状都在）、查询解释与截断/降级状态

#### Scenario: 引擎新增字段不导致失败

- **WHEN** 引擎响应里出现 schema 未声明的新字段
- **THEN** 载荷照样通过复核（新字段一并透传给脚本），调用不失败

#### Scenario: 软失败仍是成功调用

- **WHEN** 引擎以 `symbol_not_found` 或 `callgraph_building` 回应（`success: false`）
- **THEN** 工具照常返回文本，载荷保留 `success: false` 与 `code`，脚本据它决定是否重试

#### Scenario: 载荷不含 envelope 的 request id

- **WHEN** 任一感知工具成功返回
- **THEN** 载荷里没有传输层的 `id` 字段

## Implementation

AFT 工具基于常驻 Rust bridge 进程池（`src/aft/bridge.ts`）：每项目根一个 bridge 进程、跨 session 共享；二进制解析顺序为缓存 → npm 平台包（`@cortexkit/aft-linux-x64`）→ PATH → cargo → GitHub release 兜底；二进制缺失时不注册工具。

- **项目根**（`src/aft/index.ts`）：取当前会话的工作目录（`session_start` 的 `ctx.cwd`），不取进程启动目录；配置读取、bridge 创建与工具取 bridge 共用同一份项目根。

- **配置**（`src/aft/config.ts`）：用户级 `aft.jsonc`——`enabled`（默认 true）、`semantic_search`（默认 false，涉及外部 embedding 后端，仅用户级可开）。
- **感知工具只读**：outline / zoom / callgraph / search 均为纯只读查询，不经过写保护审批；写类能力（符号重命名、跨文件引用更新）由 LSP 侧的 `lsp-rename` 承接。
- **语义搜索**：`semantic_search: true` 时注册 `aft_search`，首次调用阻塞至多 3600 秒（1 小时，`SEMANTIC_INDEX_WAIT_TIMEOUT_MS`，与 Rust 侧 `AFT_WAIT_FOR_SEMANTIC_READY_MS` 一致）等索引构建完成。
- sessionId 传给 Rust 侧做 undo / checkpoint 作用域。

涉及文件：`src/aft/`（tools.ts / bridge.ts / config.ts / index.ts）。
