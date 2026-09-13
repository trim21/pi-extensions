# Design — LSP 工作区监听的内核层排除

## Context

- `watcher.ts` 的 `watchWorkspace` 用 `node:fs/promises` 的 `watch(dir, { recursive: true, signal })`；Linux 上 Node 内部（`lib/internal/fs/recursive_watch.js`）对每个子目录逐个 `fs.watch`。
- 现有忽略（`DEFAULT_IGNORE` + `lsp.json` 的 `watch.ignore`）只在事件消费侧 minimatch 过滤，内核 watch 照建。
- Node 的 recursive watch 在配额耗尽（ENOSPC）时对内部无 listener 的 FSWatcher emit `'error'`，成为未处理异常直接崩掉 pi 进程（用户实机崩溃栈：watch `.git/index.lock`，Node v26.6.0）。上游修复 nodejs/node#65635（2026-08-31 合入 main）尚未进任何发布版。
- Node >= 24.14（backport，d6f7c8d06fd）/ 26 的 recursive watch 支持 `ignore` 选项：内部用 vendored minimatch（`matchBase: true`、`nocase` 于 win/mac、`nonegate: true`、`nocomment: true`）对相对根的路径逐条匹配，命中路径**不创建内核 watch**（已在本地 Node v24.20.0 运行时验证：ignored 子树创建文件无任何事件）。
- `lsp.json` 的 `watch.ignore` 字段已存在（`lsp.ts` 的 `watchConfigSchema` / `watchOptions`），本地 `<cwd>/.pi/lsp.json` 与全局配置按现有机制合并；本改动不改 schema。

## Goals / Non-Goals

**Goals:**

- 忽略规则命中的目录在内核层不创建 inotify watch，从根上消除 ENOSPC 崩溃。
- `lsp.json` 的 `watch.ignore` 对内核层生效（本地配置可排除任意目录，如 `hs-assets` 场景的 `.git`）。
- 不支持 `ignore` 选项的旧 Node 上行为不劣于现状（回退事件层过滤）。
- 事件层过滤保持现有语义不变（runtime 新建的 ignored 目录仍可能产生少量事件，由事件层兜底）。

**Non-Goals:**

- 不改 `lsp.json` schema、不新增配置字段。
- 不处理 Node recursive watch 内部 unhandled `'error'` 的其他触发路径（上游修复跟进后自然解决）。
- 不实现自适应 watch 配额探测或降级轮询。

## Decisions

### D1：把忽略列表直接传给 `fs.watch` 的 `ignore` 选项，而非自建目录遍历排除

- `watchWorkspace` 组装 `ignore` 传给 `watch(dir, { recursive: true, signal, ignore })`。
- 备选：自己逐目录 watch 并跳过 ignored 子树 —— 重复实现 Node 内部逻辑，且和 `fs/promises` 约定冲突；否决。
- 备选：只提高 `fs.inotify.max_user_watches`（用户侧 sysctl）—— 症状压制，仓库大小无上界；否决。

### D2：内核层 pattern 需覆盖"目录本身"与"目录内容"两种形态

Node 内部在遍历子项时用相对路径匹配：`.git` 本身只匹配 `**/.git`（或依赖 `matchBase` 的 `*.git` 形态），不匹配 `**/.git/**`。若只传现有 pattern，`.git` 目录本身仍占一个 watch（可接受但不彻底）。

- `DEFAULT_IGNORE` 拆为单一来源列表（目录名形式），派生函数为每条 pattern 追加其去掉尾部 `/**` 的形态，去重后同时用于内核 `ignore` 与事件层过滤。
- 事件层 `isIgnored` 的 minimatch 调用参数不变；派生 pattern 对事件层过滤是严格超集（多排除目录本身的事件，目录事件本就被丢弃），无行为回归。
- `matchBase: true` 意味着无斜杠 pattern（如用户配 `cache`）按 basename 匹配任意层级，与事件层 minimatch（默认无 matchBase）语义有差异；在 `watcher.ts` 文档注释中说明，不强行对齐。

### D3：`watch.ignore` 配置复用现有管道，只改作用范围

`watchOptions(config).ignore` 已透传到 `watchWorkspace` 的 `options.ignore`，改后自动获得内核层效果。无 schema / 合并逻辑改动。

### D4：旧 Node 兼容为"静默回退"，不做运行时探测

`ignore` 未知选项在旧 Node 被 silently 忽略（v24.14 之前的 recursive watch 不校验该字段），内核层退化为现状、事件层过滤仍在。不为探测版本引入分支复杂度。

## Risks / Trade-offs

- [Node vendored minimatch 版本与仓库 `minimatch` 依赖的 pattern 语义差异（如 `nonegate`：内核层不认 `!` 否定）] → 内核层 pattern 由派生函数从事件层 pattern 生成，负向 pattern 仅存在于用户显式配置；文档注释声明内核层不支持的写法，极端情况下退化为"多 watch 但事件层仍过滤"，不产生错误行为。
- [ignored 目录自身的单个内核 watch 仍会创建（父目录遍历时命中的是子项，目录本身可能已建 watch）] → 单目录一个 watch 量级可忽略；其事件由事件层过滤。
- [用户配了过宽的 `watch.ignore`（如 `**`）导致诊断静默失效] → 现有事件层过滤本就有同样风险，不新增防护；属于配置错误而非实现缺陷。
- [测试环境 inotify 上限差异导致内核层断言不稳定] → 测试用临时目录 + 少量文件，断言"ignored 子树事件不产生"（行为等价于不建 watch），不直接断言 inotify 数量。

## Migration Plan

单扩展行为增强，无迁移。合入后重启 pi agent 生效；回滚即 revert。

## Open Questions

（无）
