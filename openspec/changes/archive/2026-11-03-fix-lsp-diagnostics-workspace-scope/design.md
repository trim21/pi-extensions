# Design

## Context

见 `proposal.md` 的 Why。当前实现的关键事实：

- `getClients(file, cwd)`（`src/lib/lsp/lsp.ts`）已经是唯一的「这个文件该由哪些服务器处理」判定：先要求文件在 `cwd` 内（`containsPath(file, cwd)`），再按扩展名、`serverRoot` 的 root 包含关系、`include` glob 逐个适配器过滤。
- client 的 root 允许不等于 cwd 甚至高于 cwd：`workingDir` 可以是绝对路径或带 `..` 的相对路径（`rootMarkers` 只会在 cwd 与文件目录之间命中，不会高于 cwd）。`watchDirFor` 已明确「root 是 cwd 的祖先时退化为 cwd，client 只服务 cwd 内的文件」，因此归属判定是 cwd 内 ∧ root 覆盖 ∧ `include` 匹配三者的交集，而不是只看 root。
- `touchFile` 在 `getClients` 之后对每个 client `didOpen` + 等待诊断，但丢弃了 client 列表。
- `LspService.diagnostics()` 把**所有** client 的 `pushDiagnostics` / `pullDiagnostics` 按绝对路径合并；`LspClient.diagnostics` 的取值同样不做 root 校验。
- 服务器可以对任意 URI 报诊断：push 的 `textDocument/publishDiagnostics`、文档 pull 的 `relatedDocuments`、`workspace/diagnostic` 的 items。
- read / edit / write 在 cwd 外文件上照样调用 `lspDiagnosticsForFile`，依赖它自己 no-op。

## Goals / Non-Goals

**Goals:**

- 「某文件的诊断只来自拥有该文件的活跃 client」成为实现层的不变式，工作区外文件与未被覆盖的文件报告为空。
- 复用一次 `getClients` 结果，不引入额外配置解析或重复 spawn 判定。

**Non-Goals:**

- 不改诊断的严重级别过滤、条数上限、等待超时与驻留 LRU 行为。
- 不阻止文件工具读写工作区外的文件（那是工具本身的行为，不在本次范围）。
- 不改变 `lsp-rename` / `lsp-inspect` 的多服务器回退策略。

## Decisions

**1. 在 `lspDiagnosticsForFile` 按「拥有该文件的 client」取诊断，而不是过滤全局聚合表。**

抽出内部 helper（形如 `openAndWaitForDiagnostics(clients, file, mode, options)`），`touchFile` 与 `lspDiagnosticsForFile` 各自先 `getClients` 一次，再调该 helper；`lspDiagnosticsForFile` 用 `clients.flatMap((c) => c.diagnostics.get(normalized) ?? [])` 汇总。

替代方案：保留全局聚合表，在 `lspDiagnosticsForFile` 里按 `containsPath(file, client.root)` 再过滤。否决原因：只挡 root，不挡 cwd 外的文件（祖先 root 的 client 会放行）、也不挡 `include` 与扩展名不匹配；而「没有任何 client 拥有该文件 → 空报告」是更直接的责任边界，且 `getClients` 已经实现了全部判定，不需要第二套规则。

**2. 让 `LspService.diagnostics()` 按 cwd 与各 client 的 root 收窄。**

聚合时跳过 `!containsPath(filePath, state.cwd) || !containsPath(filePath, client.root)` 的条目。理由：这是公开 API，若以后又有人拿它做报告，同样的泄漏会重现；只按 root 收窄不够——root 高于 cwd 的 client 仍会把 cwd 外的条目带进来。`LspClient.diagnostics` 本身保持原样（它是 client 的原始视图，测试直接用）。

**3. 未拥有该文件时提前返回空报告，不做 `didOpen` / 等待。**

保持现有 `touchFile` 在 `getClients` 为空时零成本的行为，只是把「报告为空」显式化，避免再查任何聚合表。

## Risks / Trade-offs

- [真实项目里服务器对 root 外文件（project references、extraPaths）诊断消失] → 这些文件本就不在会话工作区，模型读写时也无从修复；若用户需要，应把该目录纳入 `cwd` 或调整 `workingDir` / `rootMarkers`。
- [两个服务器 root 重叠时某文件的诊断从「多份」变成「只来自拥有者」] → `getClients` 会把所有 root 包含该文件的 client 都返回，拥有者仍全部计入；只有不拥有该文件的 client 被排除。
- [测试 fixture 只能为 didOpen 的文件推送诊断，难以复现泄漏] → 给 `test/fixtures/mock-lsp-server.mjs` 加一个环境变量开关，让它额外为指定 URI 推送诊断，用于构造「服务器为 root 外路径报诊断」的场景。

## Migration Plan

纯行为修正，无数据迁移。回滚只需还原 `src/lib/lsp/lsp.ts` 的改动；spec delta 随 change 归档同步。
