# Design: refactor-lsp-manager-lifecycle

## Context

现状：`registerLsp(pi)` 在扩展 load 时创建 service（`createLspService`），把配置预加载（fire-and-forget）、status 渲染、进程清理散挂成多个 pi 事件，并把 service 实例直接交给两个 files.ts 的 `registerFileTools(pi, state, service)`；LSP 工具（rename + inspect 族）随之无条件注册。pi 侧事实（已核对 SDK 源码）：`session_start` handler 被 await 且先于任何 agent turn；此时 `registerTool` 经 `refreshTools()` 触发工具表全量重建，首轮对话可见；allowlist 会话（spawn-agent 子代理）在每次重建时把白名单内全部已注册工具推入 active，迟到注册正常生效；扩展实例随会话替换重建，`session_shutdown` 清理旧实例。

## Goals / Non-Goals

**Goals:**

- 未配置 lsp.json 时 LSP 专属工具完全不出现在模型工具列表。
- 装配逻辑收敛进单个 `LspManager`，与 pi 会话生命周期对齐。
- 文件工具（无条件注册）在 LSP 任何状态下行为不变。

**Non-Goals:**

- 不改 service 本体（`createLspService`）的请求管线、进程惰性 spawn、诊断等待语义。
- 不改 LSP 工具的参数与输出格式。
- 不做配置热重载（/lsp-reload 已覆盖单服务器重启；整体配置变化仍靠 /reload）。

## Decisions

- **`createLspManager(pi, options, hooks)` 工厂返回 manager**，内部注册全部生命周期事件；`registerLsp` 移除。hooks.onEnabled(pi, service) 是唯一的 LSP 工具注册入口，claude-code 在其中捕获 load 时创建的 state 闭包传 `recordReads`。
- **mustLazyGetService 永不抛错**：enabled → 实例；否则返回模块内共享的 no-op service（`createLspService()` 无配置实例，getClients 对任何文件返回空列表，诊断/通知 no-op）。不做按需创建——disabled 判定已经在 session_start 完成，事后创建只会引入竞争。（备选：访问器抛错由工具捕获——文件工具每个调用点都要 try/catch，噪声大且语义模糊。）
- **session_start 内 await 配置加载**：pi await handler，配置加载慢会推迟首 turn；本地文件读取 <1ms，且换来"首轮前工具集确定"的确定性语义。（备选：保持 fire-and-forget——工具注册时点不确定，可能出现首轮有/次轮无的工具集抖动。）
- **命令无条件注册**：/lsp-stop、/lsp-start、/lsp-reload 在 load 时注册，handler 走 mustLazyGetService，disabled 时提示不报错。命令不占模型 prompt，无条件注册无害。
- **测试的 mock pi 捕获事件 handler**：e2e / 工具注册测试把 `session_start` handler 取出来手动以 `{cwd, ui}` 触发，模拟真实时序；新增"无 lsp.json 不注册 LSP 工具"断言。

## Risks / Trade-offs

- [session_start 阻塞首 turn] → 配置读取是本地 stat/readFile，量级 <1ms；校验失败也只 notify + 降级，不抛错。
- [no-op service 与真实 service 行为漂移] → no-op 实例复用同一 `createLspService` 代码路径，仅配置为空；"无匹配服务器 → 空 client 列表"是既有语义，已有测试覆盖。
- [工具集随会话动态变化造成困惑] → 这正是本次语义（配置决定工具）；/reload 后工具集与新配置一致，promptSnippet / guidelines 随工具表重建，无残留。

## Migration Plan

纯内部重构 + 工具可见性变化，无数据迁移。回滚 = revert 两个 files.ts 签名与 lsp.ts 装配。

## Open Questions

（无）
