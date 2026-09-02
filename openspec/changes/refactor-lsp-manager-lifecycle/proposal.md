# Proposal: refactor-lsp-manager-lifecycle

## Why

`registerLsp` 在扩展 load 时急切创建 service 并无条件注册全部 LSP 工具：`lsp.json` 未配置时模型仍然看到 `lsp-rename` / `lsp-find-definition` / `lsp-find-reference` / `lsp-inspect`，调用必然失败且占用 prompt。同时 LSP 的装配逻辑分散（service 闭包 + pi 事件散挂），与 pi 的会话生命周期（扩展实例随 startup / reload / new / resume / fork 重建）不对齐。

## What Changes

- 新增 `LspManager`：`session_start` 惰性加载并校验 `lsp.json`；配置有效才创建 service（服务器进程仍首次工具调用才 spawn）并注册 LSP 专属工具；否则保持 disabled 状态。
- LSP 专属工具（`lsp-rename` / `lsp-find-definition` / `lsp-find-reference` / `lsp-inspect`）改为条件注册：仅在存在 enabled 服务器时对模型可见。
- read / edit / write 文件工具保持无条件注册，但对 LSP service 的依赖改为惰性访问器：disabled / 未创建时返回共享 no-op service（诊断与文件事件通知为空操作），文件工具在任何状态下行为不变、不抛错。
- `/lsp-stop` / `/lsp-start` / `/lsp-reload` 命令保持无条件注册，disabled 时给出友好提示。
- 配置加载从 fire-and-forget 预校验改为 `session_start` 内 await（pi 会 await 该 handler；本地文件读取通常 <1ms）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `lsp`: 新增"LSP 工具条件注册"与"惰性生命周期"两个需求（工具何时可见、配置何时加载、service 不可用时的降级语义）；现有服务器配置解析、启动、诊断、rename 行为均不变。

## Impact

- `src/lib/lsp/lsp.ts`：`registerLsp` 装配职责移入 `LspManager`（service 本体 `createLspService` 保留）。
- `src/claude-code/files.ts`、`src/opencode/files.ts`：`registerFileTools` 签名从直接持有 `service` 改为惰性访问器；LSP 工具注册移入 onEnabled 回调。
- 测试：mock pi 需触发 `session_start`；新增"无 lsp.json 时不注册 LSP 工具"断言；既有 e2e 适配。
