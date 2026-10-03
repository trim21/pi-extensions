# Proposal

## Why

codemode 脚本现在只能通过 `call("Read", …)` / `call("Write", …)` 碰文件，而这两条路是给 LLM 上下文设计的：

- `Read` 返回的是 `cat -n` 行号文本、按行/字节截断，超过 256KB 还会要求 offset/limit——脚本要的是原始内容，行号会让正则和 JSON 解析直接失败；
- `Write`/`Edit` 的语义围绕「模型改一段」设计（行号锚点、精确 old_string），批量生成或整体重写很别扭；
- 每次调用都要走一遍面向模型的工具机器（pendant、参数 schema、嵌套调用记录）。

所以脚本化的文件处理（读一堆文件算一遍、按规则重写、生成报告）目前要么做不到，要么得先剥行号再拼回去。本次给脚本加一组自己的文件原语 `fs.read` / `fs.write`。

## What Changes

- codemode 脚本新增 `fs` 对象：`fs.read(path)` 返回**原始 UTF-8 文本**（不加行号、不截断），`fs.write(path, content)` 整体写入。相对路径相对本次调用的 cwd 解析。
- **脚本不再能调用文件读写工具**：`Read` / `Edit` / `Write`（含 opencode 的小写 `read` / `edit` / `write`）从可调用集合里排除，脚本碰文件只有 `fs.read` / `fs.write` 一条路——不重复给一套为 LLM 上下文设计的行号/截断/锚点语义。`Glob` / `Grep` 不受影响。
- `fs` 由宿主用 `node:fs/promises` 直接实现，**不是工具**：不进工具总线、不出现在 `ALL_TOOLS` 与工具列表里，也不受 `personalExtensions.disabledTools` / active 工具求交约束（与 `store` / `text` 同级的脚本内建能力）。
- **stale 保护沿用仓库既有机制**：`fs.write` 要求目标文件处于「已读且读后未变」状态（`src/lib/file-reads.ts` 的 `requireCurrentRead`），未读或读后被外部改过都拒绝；文件不存在时允许直接创建（与 `Write` 的新建文件例外一致）。已读记账存在 codemode 自己的工具结果 `details.reads` 上，与既有 `details.store` 同一条恢复路径。
- **写入仍走 write-guard**：工作区内与 `/tmp` 自动放行；工作区外弹审批，预览里给出 before/after diff；headless、Windows、`/bwrap-deny-request` 下直接拒绝。因此 `fs.write` 不是绕过审批的后门。
- `fs` 的声明渲染进 codemode 的工具描述，与现有 `declare function call(...)` 重载并列，模型写脚本前就能看到这两个方法。
- 首期只做 `read` / `write`；`glob` / `grep` / `list` / `stat` / `mkdir` / `rm`、二进制与编码参数、流式读写都不在范围。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `codemode`: 脚本接口新增 `fs.read` / `fs.write` 两个文件原语，规定其返回语义（原文、不截断、不设大小上限）、路径解析、stale 保护与 write-guard 审批行为，以及它们在工具描述里的声明；可调用工具集合新增文件读写工具的排除。

## Impact

- 代码：`src/codemode/fs.ts`（新增的宿主侧实现）、`src/codemode/prelude.ts`（`fs` 命名空间）、`src/codemode/tool.ts`（分发、排除名单与描述）、`src/codemode/declarations.ts`（`fs` 声明）、重建产物 `src/codemode/worker.js`、`src/index.ts`（把 `services.policy` 与 `fileToolset.reads` 注入 codemode）、`src/claude-code/files.ts` 与 `src/opencode/files.ts`（工具集暴露 `reads`，重放已读时带上 codemode 的名字）。
- 复用：`src/lib/file-reads.ts`（`snapshotOf` / `recordRead` / `restoreReads` / `requireCurrentRead`）、`src/lib/write-guard.ts`（`guardWriteAccess`）。
- 测试：`test/codemode-fs.test.ts`（新增）、`test/codemode-tool.test.ts`（`fs` 声明与文件工具被排除的断言、端到端 fs 脚本）。
- 文档：`README.md` 的 codemode 段落补 `fs` 与「文件工具不再可调用」。
- 行为：脚本的能力面变化（新增 fs 原语、移除文件工具）；工具面向模型的输出不变，`fs` 也不是工具，不出现在模型的工具列表里。
- 交付顺序：本变更的 spec delta 修改了「工具注册与可调用工具集合」，而 `codemode-call-structured-results` 也改同一条——归档时必须先同步/归档后者，再归档本变更，否则那条 requirement 会丢掉返回类型那一段。
