## Why

`aft_callgraph` 的 `trace_to_symbol` / `trace_data` 在调用图存储后台重建期间直接把 `callgraph_building` 文案返回给模型（本会话实测：watcher overflow 触发重建后连续多次调用都是该提示），模型拿到的是无效答复。aft 侧其实有内联等待窗口 `AFT_CALLGRAPH_BUILD_WAIT_MS`（生产默认 `0` = 立即返回 building），我们没设。

`aft_search` 的默认 embedding 后端是本地 ONNX（fastembed），内网镜像不提供 ONNX Runtime，所以它实际不可用；而语义搜索本身对我们有用，应该改走外部 embedding 端点。

同时 aft 的 prompt 与注释里留着三处过期指引，都会把模型推向不存在的概念或工具：`refactor.md:5` 与 `refactor.ts:77` 推荐从未注册的 `aft_move`；`refactor.ts:6` 与 `refactor.md:5` 用"自动创建 checkpoint"暗示模型可以自助回退；`outline.md:11` 把模型指向条件注册的 `aft_search`。另有 `src/aft/ast-edit.ts` 与其测试合计 607 行，`registerAstEditTool` 在全仓库无调用点，属未接线死代码。

本仓库的分工前提与普通 aft 插件不同：**模型只负责改文件，恢复与 OS 级文件操作由人通过 git 完成**。因此 aft 的 `aft_safety`（undo / history / checkpoint / restore / list）、`aft_delete`、`aft_move` 都不属于模型工具面；本次把这条边界写成 aft capability 的显式约束，防止后续又被"顺手补齐"。

## What Changes

- 创建 bridge pool 时设置 `AFT_CALLGRAPH_BUILD_WAIT_MS = 30000`，让冷构建与 watcher 重建在调用内等待就绪后返回真实结果；窗口耗尽仍返回 `callgraph_building` 软码。
- `aft_search` 只接受外部 embedding 后端：`semantic.backend` 为 `openai_compatible` 或 `ollama` 且配了 `semantic.base_url` 时才注册，`fastembed`（本地 ONNX）一律不注册并在 session 开始时说明原因。
- 密钥送达：用户在用户级 aft.jsonc 配 `semantic.api_key`（值）时，由扩展注入成 aft 子进程的环境变量，并在用户没指定 `semantic.api_key_env` 时追加一份用户级 config tier 告知 aft 该读哪个固定变量名；指定了 `api_key_env` 就以它为准；两者都不配即无鉴权端点。密钥值不进日志、错误文本与 pendant。
- 清理过期 prompt：删掉对 `aft_move` 的推荐与"执行前自动创建 checkpoint"这类回退暗示；`outline.md` 不再指向条件注册的 `aft_search`；`search.md` 与 `aft_search` description 去掉对模型无意义的配置说明。
- 删除 `src/aft/ast-edit.ts` 与 `test/aft-ast-edit.test.ts`（未注册死代码）。
- 新增回归护栏 `test/aft-index.test.ts`：断言注册面集合、prompt 文本不引用未注册工具、description 不含自助回退语义。
- 明确不接入：`aft_move`、`aft_delete`、`aft_safety`（回滚与 OS 级文件操作不属于模型面）、`aft_inspect`（dead_code / unused_exports 依赖同一个 callgraph store，锁定的 0.53 又不报告未就绪分类，空结果无法与"确实没有"区分）、`aft_import` 的 `organize` op（排序规则由各仓库 lint 决定）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `aft`: callgraph 增加索引未就绪时的内联等待语义；语义搜索改为只使用外部 embedding 后端并规定密钥送达方式；新增"不向模型暴露回滚与 OS 级文件操作"与"prompt 引用的工具名必须已注册、不留未接线实现"两条约束。

## Impact

- 代码：`src/aft/bridge.ts`（`CALLGRAPH_BUILD_WAIT_MS`、`SEMANTIC_API_KEY_ENV`、`createAftPool` 接收 `SemanticRemote` 并注入 childEnv + config tier）、`src/aft/config.ts`（typebox 两层解析：`semantic.backend` / `base_url` / `api_key_env` / `api_key`）、`src/aft/index.ts`（注册门控与 notify）；prompt 与注释：`callgraph.md`、`refactor.md`、`refactor.ts`、`outline.md`、`search.md`、`tools.ts`。
- 删除：`src/aft/ast-edit.ts`（310 行）、`test/aft-ast-edit.test.ts`（297 行）。
- 测试：新增 `test/aft-bridge.test.ts`（等待窗口 + 密钥注入三种组合 + 密钥不外泄）、`test/aft-index.test.ts`（注册面与 prompt 文本护栏）；扩充 `test/aft-config.test.ts`（外部后端与密钥字段解析）。
- 依赖：无版本变更。行为契约取自锁定的 `@cortexkit/aft-bridge` / `@cortexkit/aft-linux-x64` **0.53.0**；`/srv/ssd-1/projects/github/cortexkit/aft` 源码为 0.54.0，个别描述与 0.53 不同，见 design。
- 模型可见面：工具集合不变（仍是不含 search 的 5 个 + 外部后端就绪时的 `aft_search`）；`ast_edit` 从未注册，删除它不改变任何现有行为。
- 安全：新增"配置里可存明文密钥"的落盘面，仅限用户级 aft.jsonc（项目级不读），扩展侧只做子进程 env 注入，不落日志。
- 不改动：`write-guard` 审批策略、`src/lib/lsp/`、任何工具的参数面。
