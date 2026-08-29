# aft Specification

## Purpose

基于常驻 Rust bridge 的代码分析工具集：感知工具（outline / zoom / callgraph / search）只读地解析符号与调用关系，写工具（refactor / import）走路径级写保护；AFT 二进制缺失时不注册工具。

## Requirements

### Requirement: 工具注册门控

工具集仅在 AFT 二进制可用时注册。

#### Scenario: 二进制缺失不注册

- **WHEN** 无法解析到 AFT 二进制（缓存、npm 平台包、PATH、cargo、GitHub release 均不可用）
- **THEN** 不注册任何工具，session 开始时 notify error

### Requirement: 感知工具只读

outline / zoom / callgraph / search 为纯只读查询。

#### Scenario: 符号大纲

- **WHEN** `aft_outline` 分析文件或目录
- **THEN** 文件返回符号大纲（签名 + 行号），目录默认返回扁平文件树（`files: false` 切换为符号大纲，30KB 截断）；目录递归上限 200 文件

#### Scenario: 符号查看

- **WHEN** `aft_zoom` 查看命名符号
- **THEN** 返回符号完整源码（代码按符号名解析，Markdown/HTML 按标题匹配；`callgraph: true` 附带同文件调用关系标注）

#### Scenario: 调用图查询

- **WHEN** `aft_callgraph` 查询调用关系
- **THEN** 按 `op`（callers / impact / call_tree / trace_to / trace_to_symbol / trace_data）返回结果；符号缺失或索引构建中返回文本说明而非报错

#### Scenario: 搜索注册门控

- **WHEN** 语义搜索未启用（`semantic_search: false`）
- **THEN** 不注册 `aft_search`；启用时首次调用阻塞等待索引构建（至多 600 秒）

### Requirement: 写工具路径级审批

refactor / import 是写操作，不支持 preview，写保护退化为路径级审批。

#### Scenario: workspace 内自动放行

- **WHEN** 重构 / import 操作的目标在 workspace 内（或 /tmp）
- **THEN** 直接执行，无需审批

#### Scenario: 外部路径审批

- **WHEN** 目标在 workspace 外部
- **THEN** 弹确认框（无 diff 预览）；headless 直接拒绝

#### Scenario: 重构前 checkpoint

- **WHEN** 执行 `move` 重构
- **THEN** 自动创建 checkpoint，且全 workspace 重写 import 与引用

### Requirement: import 管理

语言感知的 import 添加与移除。

#### Scenario: 多语言 import 操作

- **WHEN** `aft_import` 执行 add / remove
- **THEN** 支持 18 种语言的具名 / 默认 / 命名空间 / 类型导入等；`remove_name` 缺省移除整个 import；不做 import 排序（交给 lint）

## Implementation

AFT 工具基于常驻 Rust bridge 进程池（`src/aft/bridge.ts`）：每项目根一个 bridge 进程、跨 session 共享；二进制解析顺序为缓存 → npm 平台包（`@cortexkit/aft-linux-x64`）→ PATH → cargo → GitHub release 兜底；二进制缺失时不注册工具。

- **配置**（`src/aft/config.ts`）：用户级 `aft.jsonc`——`enabled`（默认 true）、`semantic_search`（默认 false，涉及外部 embedding 后端，仅用户级可开）。
- **感知 / 写工具分离**：outline / zoom / callgraph / search 纯只读，不过写保护；refactor / import 是写操作，不支持 preview，写保护退化为路径级审批（workspace 内与 /tmp 自动放行，外部弹确认框、headless 拒绝，无 diff 预览）。
- **重构**：`move` 只支持顶层符号，执行前自动 checkpoint，全 workspace 重写 import 与引用；`extract` 支持 TS/JS/TSX/Python 行区间。
- **import**：支持 18 种语言的具名 / 默认 / 命名空间 / 类型导入等，`validate` 默认 syntax 级；不做 import 排序（交给 lint）。
- **语义搜索**：`semantic_search: true` 时注册 `aft_search`，首次调用阻塞至多 600 秒等索引构建完成。
- sessionId 传给 Rust 侧做 undo / checkpoint 作用域。

涉及文件：`src/aft/`（tools.ts / bridge.ts / config.ts / refactor.ts / imports.ts / index.ts）。
