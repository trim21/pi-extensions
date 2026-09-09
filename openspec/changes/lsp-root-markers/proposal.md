# LSP 项目根标记（rootMarkers）

## Why

LSP 服务器的 root 目前只有两个来源：会话 cwd，或 per-server 的 `workingDir`（固定目录）。当 cwd 是容器目录——其下并列多个独立项目（`~/projects/a`、`~/projects/b`，或一个目录里并列的 `sdk/python` 与 `sdk/go`）——所有文件都被当成同一个项目加载：语言服务器找不到各自的项目配置，类型解析与诊断落在错误的项目上下文里。用户只能为每个子项目手写一条 server 配置（每新增一个子项目都要改配置）。

`rootMarkers`（按标记文件定位项目根）在配置驱动重构前存在，重构时随 `findRoot` 一起删除。本变更把它按现有配置模型加回来，并且不引入任何内置默认：不配置时行为与现在完全一致。

搜索方向取"最外层"而不是"离文件最近"：语言服务器的项目配置（如 tsserver 的 tsconfig）通常向上查找但被 LSP root 截断，root 比配置更深会让根配置完全加载不到；取最外层则更深处的配置仍会被服务器自己向上找到。

## What Changes

- `lsp.json` 的 `servers.<id>` 新增可选字段 `rootMarkers: string[]`（精确文件名，目录名也可）：从会话 cwd 沿文件路径逐级向下查找，第一个含标记的目录即该文件的 LSP root（cwd 自身含标记时即 cwd）；路径上没有命中时回退会话 cwd。取最外层命中意味着 cwd 本身是项目根时行为与现状完全一致，`rootMarkers` 只对"cwd 是容器目录、其下有多个独立项目"生效。
- `rootMarkers` 与 `workingDir` 互斥：同时配置视为配置错误，在配置解析时报错（与 `enabled` 引用未注册 id 同类），不做静默取舍。
- 同一服务器可因 `rootMarkers` 解析出多个 root（cwd 之下并列的多个项目各成一个 root）：每个 root 一个独立 client（沿用现有 `root + serverID` 缓存键），可执行文件 / `{root}` 模板 / 工作区二进制查找都按各自 root 生效；状态栏按 root 分别显示。
- `/lsp-reload` 后按 (serverID, root) 对恢复此前运行中的实例（当前实现只按 serverID 恢复单个 root，多实例场景会漏恢复）。
- 更新 `lsp-config` skill 文档与 lsp spec 的根定位 Requirement。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `lsp`: 「服务器启动」Requirement 的项目根定位 Scenario——明确 `rootMarkers` 从 cwd 向下取最外层命中、搜索不越 cwd、未命中回退 cwd、与 `workingDir` 的互斥校验，以及同一服务器多 root / 多 client 实例的语义。

## Impact

- `src/lib/lsp/server-config.ts`：`serverConfigSchema` 增 `rootMarkers`；`ConfigAdapter` 暴露该字段。
- `src/lib/lsp/adapter.ts`：root 解析函数改为按 `(workingDir | rootMarkers, file, cwd)` 求 root，标记搜索沿 cwd→文件的目录链向下（不越 cwd）。
- `src/lib/lsp/lsp.ts`：`resolveConfig` 增加互斥校验；`getClients` 按文件解析 root；`respawnRunning` 按 (serverID, root) 对重启。
- 测试：`test/lsp-server-config.test.ts`（root 解析 / 多实例 / 互斥校验）、`test/lsp-config.test.ts`（reload 恢复多 root）。
- 文档：`src/skills/lsp-config/SKILL.md`、`openspec/specs/lsp/spec.md`。
- 本机配置（非仓库改动，可选）：给 `~/.pi/agent/lsp.json` 的 typescript / pyright / rust-analyzer / go 服务器补 `rootMarkers`，让子目录项目实际生效。
