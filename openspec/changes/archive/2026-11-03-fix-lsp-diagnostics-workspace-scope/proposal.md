# Proposal

## Why

read / write 工作区以外的文件时，工具仍可能把 LSP 诊断附在结果后面，尽管那个文件不属于任何活跃服务器的工作区。原因是 `lspDiagnosticsForFile` 虽然用 `getClients` 拒绝为工作区外文件 `didOpen`，却从「所有 client 按绝对路径聚合」的诊断表里按路径取值；服务器允许对任意 URI 推送诊断（`publishDiagnostics`、pull 的 `relatedDocuments`、`workspace/diagnostic` 的 items），例如 tsserver 的 project references 或 pyright 的 extraPaths 报出 root 之外的路径。于是模型读到工作区外文件时会把别的项目的诊断当成该文件的诊断，误导修复方向。

## What Changes

- `lspDiagnosticsForFile` 只从「拥有该文件的 client」取诊断（即 `getClients` 返回的那批 client），不再查全局按路径聚合的诊断表；归属判定沿用 `getClients`：文件在会话 cwd 内，且某个 client 的 root（可能不等于 cwd，`workingDir` 允许指向祖先目录）与 `include` 覆盖它。
- 不属于任何 client 的文件（cwd 外、root 覆盖不到、被 `include` 排除）读后 / 写后诊断报告固定为空，不做任何 `didOpen` 与等待。
- `LspService.diagnostics()` 的聚合结果按「在 cwd 内且在该 client 的 root 内」收窄，避免同一条泄漏从这层公开 API 再现。
- `touchFile` 与 `lspDiagnosticsForFile` 共用一个内部 helper，避免为同一个文件重复解析配置、重复走 `getClients`。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `lsp`: 「读后与写后诊断」增加工作区归属约束——报告只来自拥有该文件的活跃服务器 client（文件在 cwd 内，且在该 client 的 root 与 `include` 覆盖范围内）；不属于任何 client 的文件不报告诊断。

## Impact

- 代码：`src/lib/lsp/lsp.ts`（`getClients` 结果复用、`touchFile` / `lspDiagnosticsForFile` / `diagnostics`）。
- 测试：`test/lsp-config.test.ts`、`test/lsp-server-config.test.ts`、`test/fixtures/mock-lsp-server.mjs`（新增为任意路径推送诊断的 fixture 开关）。
- 工具行为：claude-code / opencode 两套文件工具的 read / edit / write 诊断输出可能变少——只少掉本就不属于该文件工作区的诊断，工作区内的报告不受影响。
- 无 API、依赖或配置格式变更。
