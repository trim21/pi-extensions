# LSP 工作区监听的内核层排除（lsp.json watch.ignore）

## Why

`watcher.ts` 对整个会话 cwd 做递归 `fs.watch`，`.git` / `.venv` / `node_modules` 等目录虽然被事件层过滤，但内核 inotify watch 仍然逐目录创建。大型仓库（含 `.git/objects` 数万子目录）会耗尽 `fs.inotify.max_user_watches`，此时 Node 的 recursive watch 实现在没有 error listener 的内部 FSWatcher 上 emit `'error'`，直接把 pi 进程打崩（用户实机复现：`ENOSPC: System limit for number of file watchers reached, watch '.git/index.lock'`，Node v26.6.0）。Node 自身的错误处理修复（nodejs/node#65635）尚未发版，必须在自己一侧不创建这些 watch。

## What Changes

- `watcher.ts` 将忽略列表传给 `fs.watch` 的 `ignore` 选项（Node >= 24.14 / 26 起，内部 recursive watch 对 ignore 命中的路径完全不创建 inotify watch，已在本地 Node v24.20 运行时验证）。
- `DEFAULT_IGNORE` 拆分为内核层排除（目录本身与其内容两种形态，如 `**/.git` + `**/.git/**`）与事件层过滤两层；事件层过滤保持现有 minimatch 语义不变。
- `lsp.json` 的 `watch.ignore`（本地 `<cwd>/.pi/lsp.json` 与全局 `~/.pi/agent/lsp.json`，本地优先合并）从"仅过滤事件"升级为"内核层不 watch + 事件层不转发"，字段与 schema 不变，行为增强、向后兼容。
- 旧的 Node（< 24.14，无 `ignore` 选项）静默忽略该选项，回退为现有事件层过滤行为，不报错。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `lsp`：工作区文件监听 Requirement 的忽略规则 Scenario 扩展——忽略规则 SHALL 应用于内核 watch 层（不创建 inotify watch），而不仅是事件过滤；`watch.ignore` 配置的作用范围相应变化。

## Impact

- `src/lib/lsp/watcher.ts`：`watchWorkspace` 传 `ignore` 给 `fs.watch`；忽略 pattern 派生逻辑。
- `src/lib/lsp/lsp.ts`：无需 schema 变更（`watch.ignore` 已存在）；确认 `EffectiveWatchConfig.ignore` 透传。
- 测试：`test/` 下 watcher 对应测试（现有测试文件迁移 + 新增内核层行为断言）。
- 风险：Node `ignore` 用内置 minimatch（`matchBase: true`、`nonegate: true`），与仓库顶层 `minimatch` 默认语义有差异，pattern 派生需覆盖两种形态；见 design.md。
