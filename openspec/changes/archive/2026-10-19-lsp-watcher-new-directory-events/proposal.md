# Proposal

## Why

工作区监听器依赖 `@parcel/watcher` 的 inotify 事件，但 parcel 只在收到目录 `IN_CREATE` 之后才给该目录建立 watch，且不会回扫目录内容；整棵目录被 move 进工作区时也只给顶层目录建 watch、不递归到已有子目录。结果是 `mkdir dir && touch dir/x` 这种紧邻写入会让 `x` 完全丢事件，移入子树里后续的修改也永远收不到——LSP 会漏掉这些文件变更。当前 `test/lsp-watcher.test.ts` 的“常见缓存 / 工具产物目录被忽略”用例正是踩在这个窗口上，最近两次 CI（node 24 / node 26）都因此失败。

## What Changes

- 目录 `created` 事件（含 `IN_MOVED_TO` 整树移入）到达后，watcher 主动扫描该目录：目录内的文件补发 `created`，目录记入已知目录集合；扫描遵循现有内置忽略、配置 `ignore` 与绝对路径 `ignoreDirs`。
- 扫描发现新建目录里已有子目录时，为该目录补挂一个子订阅（`@parcel/watcher` 的递归订阅），让移入子树的嵌套目录后续变更也能产生事件；子订阅在目录被删除或 watcher 停止时退订。
- 同一路径可能同时被子订阅与父订阅各投递一次；重复事件对 `workspace/didChangeWatchedFiles` 无害，本变更不做去重。
- 新增回归测试：目录创建后不等待立即写入的文件必须上报；整树移入后对嵌套目录的修改必须上报。现有失败用例改为不依赖固定时序。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `lsp`: “工作区文件事件同步”新增要求——新建目录内已存在的文件与整树移入的内容必须补投 `created`，移入子树的后续变更也必须持续产生事件。

## Impact

- 代码：`src/lib/lsp/watcher.ts`（目录扫描、子订阅及其生命周期、忽略规则复用）。
- 行为：目录创建与整树移入后的事件面更完整；子树内可能收到重复事件；目录创建时产生一次 `readdir` 扫描开销（被忽略目录不扫描）。
- 依赖：无新增依赖，仍使用 `@parcel/watcher` 的 `subscribe` / `unsubscribe`。
- 测试：`test/lsp-watcher.test.ts`（新增目录立即写入、移入子树、删除清理用例）。
- 文档：`openspec/specs/lsp/spec.md`。
