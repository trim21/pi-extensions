# Proposal

> **结果：已实现并实测，随后撤回**（代码回到改动前）。净 +189 行、单个调用点 5 行 → 9 行，且 8 个调用点并不同构。判据、数字与「不要重提」的记录见 design.md。

## Why

「文件被工具触碰后，取它的 LSP 诊断」这件事没有归属地。8 个调用点各自把同一段两行拼一遍，其中转发 `notify` / `signal` / `cwd` 的写法在 claude-code 里出现 4 次：

```
const reads = await recordRead(state, path, snapshotOf(content));
const diagnostics = await getService().lspDiagnosticsForFile(path, ctx.cwd, {
  notify: (message, level) => ctx.ui.notify(message, level),
  signal,
});
```

上一轮 `refactor-file-read-accounting` 只收掉了这段里的记账两件（key 解析 + `recordRead`）与守卫，诊断那一半留在调用点。后果是「怎么取一个文件的诊断」要在 `src/claude-code/files.ts` 与 `src/opencode/files.ts` 之间来回对照——两套工具集的写法已经不同（claude-code 传 `notify`、opencode 不传），而没有任何一处声明这是有意的差异。

与刚完成的 `refactor-egress-module` 同类：不是顺手去重，是「读 / 编辑 / 写之后要报这个文件的诊断」这件事没有一处能回答。

## What Changes

- 新增 `src/lib/file-diagnostics.ts`，导出 `recordFileWithDiagnostics(deps)`：接收 `{ state, path, snapshot, cwd, getService, notify?, signal }`，内部固定「先 `recordRead`、后 `lspDiagnosticsForFile`」的顺序，返回 `{ reads, diagnostics }` 两个事实。
- 8 个调用点（claude-code 的 Read 文本 / Edit 创建 / Edit 替换 / Write，opencode 的 read / edit 创建 / edit 替换 / write）各收成一行。
- 新增 `test/file-diagnostics.test.ts`：钉住返回值（`reads` 的 key 与 `recordRead` 一致、`diagnostics` 原样透传）与转发参数（`path` / `cwd` / `notify` / `signal` 抵达 service）。
- **行为零变化**：工具输出文案、`<diagnostics>` 块、pendant subtitle 的 error/warning 计数、`details.reads` 的格式、`ctx.ui.notify` 的传递（claude-code 传、opencode 不传）全部保持原样。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无。工具输出、诊断块、pendant 计数与记账格式都不变，因此 `.openspec.yaml` 标记 `skip_specs: true`。）

## Impact

- 代码：新增 `src/lib/file-diagnostics.ts`；`src/claude-code/files.ts`（4 处）、`src/opencode/files.ts`（4 处）改为调用它。
- 测试：新增 `test/file-diagnostics.test.ts`；`test/claude-code-tools.test.ts`、`test/opencode-read.test.ts`、`test/opencode-edit.test.ts`、`test/opencode-write.test.ts`、`test/claude-code-signal.test.ts` 必须原样通过（它们是「行为不变」的证据）。
- 不涉及：`src/lib/file-reads.ts`、`src/lib/lsp/*`、`src/lib/path.ts`、图片读取分支、`rename-tool.ts` 的多文件诊断、配置格式、依赖。
