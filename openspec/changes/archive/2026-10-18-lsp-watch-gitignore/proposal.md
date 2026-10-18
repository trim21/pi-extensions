# Proposal

## Why

工作区监听器目前只按内置目录列表（`node_modules`、`dist`、`build`、`.venv` 等）和手工配置的 `watch.ignore` 排除路径。用户已经在 `.gitignore` 里表达过“这些目录不用看”（`__pycache__`、`.pytest_cache`、`.next`、`.cache`、`out` 等），但监听器仍会为它们建立 inotify watch 并接收事件。大型仓库里这直接消耗 watch 配额、放大事件洪峰，而手工抄一份 `watch.ignore` 既重复又容易过期。

## What Changes

- 新增顶层配置 `watch.useGitignore`（缺省 `true`）：对每个监听 root 用 git 自己计算“整体被忽略的目录”，把这些目录追加到监听器的忽略集合，在内核层不建立 watch，并从事件层兜底过滤。
- 该计算不解析 gitignore 语法，直接使用 `git ls-files --others --ignored --exclude-standard --directory -z` 的输出（完整覆盖嵌套 `.gitignore`、`.git/info/exclude`、`core.excludesFile` 与取反规则语义）；非 git 仓库、git 不可用或超时（3s）时静默跳过，退回现有行为。
- `.gitignore` 变更后重建该 root 的监听器以刷新忽略集合（`.git/info/exclude` 与全局 excludesfile 的变更仍需 `/lsp-reload`）。
- 只做目录级排除：被忽略的单个文件不进入忽略集合，仍按其是否落在被忽略目录内决定去留。
- 扩充内置忽略目录：在现有 `node_modules` / `.git` / `dist` / `build` / `.venv` / `venv` / `target` / `coverage` 之外，加入语义明确的缓存与工具产物目录（`__pycache__`、`.mypy_cache`、`.pytest_cache`、`.ruff_cache`、`.cache`、`.next`、`.turbo`、`.gradle`、`.tox`、`.nox`、`.idea`）。`out` / `bin` / `obj` 不加入——这些名字可能承载源码或构建输入，误排除会让 LSP 漏掉改动。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `lsp`: “工作区文件事件同步”的忽略规则扩展为同时遵循内置缓存目录清单与 gitignore 中被整体忽略的目录，并新增对应配置开关与 `.gitignore` 变更后的刷新行为。

## Impact

- 代码：`src/lib/lsp/lsp.ts`（`watch` 配置 schema、生效配置解析、`startWatcher`、`.gitignore` 变更触发重建）、`src/lib/lsp/gitignore.ts`（新增，计算 git 忽略目录）、`src/lib/lsp/watcher.ts`（新增 `ignoreDirs` 参数传给 `@parcel/watcher`、扩充内置忽略清单）。
- 行为：被 gitignore 的整体忽略目录与新增内置缓存目录不再产生 `workspace/didChangeWatchedFiles` 事件；默认开启会改变现有事件面，可用 `watch.useGitignore: false` 关掉 gitignore 部分，内置清单始终生效。
- 依赖：调用系统 `git`（无新增 npm 依赖），需要一次子进程扫描，带超时保护。
- 测试：`test/lsp-config.test.ts`（配置解析）、`test/lsp-watcher.test.ts`（忽略目录不建 watch、不投递事件）。
- 文档：`openspec/specs/lsp/spec.md`、`src/skills/lsp-config/SKILL.md`。
