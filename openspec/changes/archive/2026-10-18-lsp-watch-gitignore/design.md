# Design

## Context

现有监听器的忽略集合由 `src/lib/lsp/watcher.ts` 的内置 glob 与 `lsp.json` 的 `watch.ignore` 组成，同时传给 `@parcel/watcher`（内核层排除，不建立 watch）和事件层 `minimatch`。参见 proposal.md 的动机。

约束与已确认的事实：

- `@parcel/watcher` 的 `ignore` 接受路径字符串、glob 或 `RegExp`。路径字符串经 `path.resolve(dir, value)` 变成绝对路径，在 native 层按绝对路径前缀匹配 (`Watcher::isIgnored`)，目录及其子项都被排除；glob 则按相对路径 picomatch 匹配。
- gitignore 语义（嵌套 `.gitignore`、锚定、目录规则、`!` 取反、`.git/info/exclude`、`core.excludesFile`）无法用 picomatch 表达，自己实现解析容易出错。
- `git ls-files --others --ignored --exclude-standard --directory -z` 直接输出“整体被忽略的目录”（尾随 `/`）与零散的被忽略文件；在 root 内执行时输出路径本来就相对 root。
- git 不允许在已被忽略的父目录内用 `!` 重新包含文件，因此目录级排除不会与取反规则冲突；单文件级 `!` 只影响文件条目，不在本设计的排除范围内。
- 内核层 `isIgnored` 在建立订阅时与运行期新目录都会调用，因此被忽略目录不会被 watch，其事件也不会到达事件层。

## Goals / Non-Goals

**Goals:**

- 让监听器在 git 工作树内自动复用 gitignore，减少 inotify watch 数量与事件量。
- 失败、非 git、超时或关闭开关时完全退回现有行为，不影响监听器启动。
- `.gitignore` 变更后自动刷新忽略集合。

**Non-Goals:**

- 不解析 gitignore 语法，不引入 gitignore 解析依赖。
- 不排除“单个被忽略文件”（只排除整体被忽略的目录）——那不减 watch 数，收益低且会让文件级取反更复杂。
- 不支持 root 是多个仓库共同父目录时逐仓库扫描；root 不是 git 工作树就跳过。
- 不监听 `.git/info/exclude` / 全局 excludesfile 的变化（它们在 `.git` 下或仓库外，需要 `/lsp-reload`）。

## Decisions

### 用 git 自己计算忽略目录

新增 `src/lib/lsp/gitignore.ts`，导出 `gitignoredDirectories(root): Promise<string[]>`：

- 执行 `git -C <root> ls-files --others --ignored --exclude-standard --directory -z`，`timeout: 3000`、有界 `maxBuffer`。
- 按 NUL 切分，只保留以 `/` 结尾的条目（目录），去掉尾 `/` 后返回 POSIX 相对路径；其余（单个被忽略文件）丢弃。
- 非 git 仓库、git 不可用、非零退出、超时一律返回 `[]`，不抛错、不提示（与监听器失败降级区分：这是优化路径，不应产生噪音）。
- 输出路径经 `path.resolve(root, value)` 转绝对路径后交给 parcel 的路径 ignore；含 glob 元字符（`*?[]{}()!`）的目录跳过，避免被 `is-glob` 误判成 glob 而改变匹配语义。

替代方案：

- 用 `ignore` npm 包解析 `.gitignore`：需要自己处理嵌套文件、父目录排除与 `core.excludesFile`，还要新增依赖；git 已经实现好且行为权威。
- 长驻 `git check-ignore --stdin` 逐事件判定：语义最全，但不减少 watch 数，只减少投递，解决不了提案里的资源/洪峰问题。
- `git status --ignored=matching --porcelain`：会同时扫描 tracked 文件状态，比 `ls-files` 慢。

### 配置开关默认开启

`watchConfigSchema` 增加 `useGitignore`，`watchDefaults.useGitignore = true`，`EffectiveWatchConfig` 与 `resolveConfig` 透传；`mergeWatch` 现有的逐字段覆盖天然支持本地关闭、全局开启。默认开启换取开箱收益，代价是 gitignore 的生成产物不再触发事件；需要时用 `watch.useGitignore: false` 恢复。

### 扩充内置忽略列表

`DEFAULT_IGNORE` 增加语义明确的缓存与工具产物目录（`__pycache__`、`.mypy_cache`、`.pytest_cache`、`.ruff_cache`、`.cache`、`.next`、`.turbo`、`.gradle`、`.tox`、`.nox`、`.idea`），让没有 `.gitignore` 或未开启 gitignore 过滤的项目也能少建 watch。`out` / `bin` / `obj` 不加入：这些名字在部分项目里是源码目录或构建输入，误排除会让 LSP 漏掉改动。清单仍是现有的事件层兜底 glob，命名与内置项保持一致。

### 传递方式：新增 `ignoreDirs` 而不是拼进 glob

`WatchOptions` 增加 `ignoreDirs?: string[]`（绝对路径，仅交给 `@parcel/watcher`），与现有 `ignore`（相对 root 的 glob，两层共用）分开。避免把目录路径转成 glob 时遇到转义、`!` 取反、平台分隔符问题；事件层不需要重复过滤，因为内核层不会产生这些目录的事件。

### `.gitignore` 变更触发该 root 重建

在 `createLspService` 闭包内维护 `Map<root, timer>`：`startWatcher` 的批次回调扫到 basename 为 `.gitignore` 的事件时，500ms 防抖后 stop 该 root 的监听器、从 `watchers` 删除，再调用现有 `reconcileWatchers(cwd)` 重建（重建会重新执行 git 计算）。重建短暂丢事件可接受；忽略失败时现有 `onError` 降级路径不变。

## Risks / Trade-offs

- [被 gitignore 的生成产物（`out/`、生成的 `.d.ts`）变更不再通知服务器，诊断可能变旧] → 默认开启但提供 `watch.useGitignore: false`；spec 与 skill 文档写明这一取舍。
- [大仓库 git 扫描耗时或占内存] → 3s 超时、有界输出、只取目录；每 root 仅在建立监听器时执行一次，失败静默退回。
- [目录名含 glob 元字符时可能被 parcel 误判成 glob] → 检测到元字符后跳过该目录，保持现状。
- [watchman backend 下 watch 不建在我们进程的 inotify 上] → 仍会减少事件投递，但不减少 watchman 自身订阅；不影响正确性，无需额外处理。
- [`.gitignore` 频繁改动导致反复重建] → 500ms 防抖合并；重建失败沿用现有错误降级。
- [git 版本差异] → `ls-files`、`--ignored`、`--exclude-standard`、`--directory` 均为长期稳定选项；任何非零退出都退回现状。
