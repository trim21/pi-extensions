# Design

## Context

见 `proposal.md`。约束：

- codemode 的脚本能力目前全部经「宿主桥接」进 VM：`prelude.ts` 里的 `bridge(kind, a, b, c)` + 主线程 `tool.ts` 的 handler 构成唯一通道，失败统一在 `settle(id, false, message)` 上回到脚本并变成 `CallFailedError`。
- 仓库已有的文件安全设施：`src/lib/write-guard.ts` 的 `guardWriteAccess`（工作区内 / `/tmp` 放行，区外弹 diff 审批，headless / Windows / `/bwrap-deny-request` 拒绝）、`src/lib/file-reads.ts` 的已读记账（`snapshotOf` / `recordRead` / `restoreReads` / `requireCurrentRead` / `requireUnchangedRead`）。
- 两套面向模型的文件工具集（claude-code / opencode）各自持有自己的 `ReadsState`，语义还不一样：claude-code 的 `Write` 要求先 `Read`（新建文件例外），opencode 只对 `edit` 要求。

## Goals / Non-Goals

**Goals:**

- 脚本能拿到**原始**文件内容、能整体写回，且写入仍受既有的审批与 stale 保护约束。
- 不新增第二套「绕过审批」的写入路径。
- 不把这两个原语暴露成工具（模型的工具列表不变）。

**Non-Goals:**

- `glob` / `grep` / `list` / `stat` / `mkdir` / `rm` / `move`（下一步再说）。
- 二进制、编码参数（`encoding: "base64"` 之类）、流式读写、部分写。
- 改变任何工具面向模型的输出。

## Decisions

### D1：`fs` 是脚本内建能力，不是工具

`fs.read` / `fs.write` 与 `store` / `text` / `image` 同级，直接由宿主实现，不进工具总线。因此它们不出现在工具列表、`ALL_TOOLS` 或工具描述的工具重载里（声明单独渲染一段 `declare const fs`），也不参与 `disabledTools` / active 工具求交。

备选 1：给 `Read` / `Write` 加 `structuredResult`，`fs.read` 做 `call("Read")` 的糖。放弃原因：`Read` 的行号文本、截断、256KB 需要 offset/limit 都是为 LLM 上下文设计的，脚本要的是原始内容；糖出来仍然是「工具语义」，等于两条路都要维护。而且用户明确要「像 nodejs 的 read/write」，不想再走 toolcall 那一层。

备选 2：注册成脚本专用工具（如 `fs-read`）经总线调用。放弃原因：要么出现在模型的工具列表里（污染），要么给总线加「script-only 注册」这层新概念；而它们的审批/记账本来就要自己接一遍，走总线只会多一层。

### D2：与文件工具集共享同一份已读记账

`fs.read` / `fs.write` 用**当前会话那套文件工具集**的 `ReadsState`（claude-code 或 opencode 实例内部的那一份）：`fs.read` 成功后 `recordRead`，`fs.write` 前 `requireCurrentRead`。两边因此完全互通——`Read` 工具读过的文件 `fs.write` 可以直接写，脚本 `fs.read` 读过的文件 `Write` / `edit` 也认（这里的「两边」指记账，文件工具本身已不可被脚本调用，见 D6）。

接线方式：

- `FileToolset` / `OpencodeFileToolset` 暴露 `readonly reads: ReadsState`（state 仍归实例所有，只是可以被读取引用）；`src/index.ts` 在会话启动时把 `fileToolset.reads` 与 `services.policy` 一起注入 `codemode.register(bus, deps)`。
- codemode 把本次执行里 fs 原语产生的已读增量写进自己的工具结果 `details.reads`；重放仍由工具集那一次 `restoreReads` 负责，所以两套工具集传给它的工具名集合都加上了 `"codemode"`——`restoreReads` 是「先清空再重放」，只允许有一个调用方，不能两边各重放一次。

代价（要写进文档）：fs 的严格程度因此跟当前文件工具集走——claude-code 下 `fs.write` 要求先读，opencode 下 `edit` 那套只要求「读过就不能再被改」。这是有意的：脚本与工具对同一个文件必须用同一份判断，否则「工具刚读过、脚本却说要先读」更让人意外。

备选：codemode 自建一份 `ReadsState`（`details.reads` 自持久化、自己重放）。放弃原因：两套记账互不相认，会出现「Read 工具读过的文件 fs.write 拒绝写」这种自相矛盾的行为，而共享的改动只有「暴露一个字段 + 两个名字集合加一项」。

### D3：写入经 `guardWriteAccess`，`policy` 由 `tool-services` 注入

`fs.write` 在落盘前调用 `guardWriteAccess(ctx, { toolName: "fs.write", absolutePath, mutation: { contentOld, contentNew }, policy, signal })`：`contentOld` 就是 `requireCurrentRead` 已经拿到的那份内容（文件不存在时是空串，与工具一致），因此 diff 预览天然可用，审批通过后 write-guard 自己还会复核一次磁盘指纹。

`policy` 从现有 `ToolServices.policy` 注入，**不**在 codemode 里另建 `createRequestPolicy(pi.events)`：同一入口里两个实例会重复注册 `/bwrap-*` 命令、重复订阅事件（见 memory #251 关于跨入口/多实例的教训）。

### D4：复用现有 `call` 帧分发，不改 worker 协议

`fs.read` / `fs.write` 走已有的 `call` 帧，工具名分别是 `fs.read` / `fs.write`；`onCall` 先查 `fs.` 前缀（走 fs 实现），未命中再查工具总线。因此 worker 协议、prelude 的 pending 表、`CallFailedError` 通道都不用动，顺便白拿 `onCallProgress` 的实时面板（脚本里会看到 `→ fs.read {…}`）。

失败语义：fs 的错误（ENOENT、非 UTF-8、未读、读后被改、审批拒绝、放不下）都经同一条失败通道 reject 成 `CallFailedError`，message 保留底层说明。将来若要区分类型，再加 `FsError` 即可，本期不做。

### D5：编码不设上限

- `fs.read` 只返回 UTF-8 文本；解码失败报错，**不静默替换**（脚本里静默替换会直接损坏数据）。
- **不设大小上限**：读到的内容不进模型上下文，所以没有「按上下文预算裁剪」的理由；读到多大都行，`fs.write` 还能原样写回去。真的放不下时（VM 堆不够、或超出宿主字符串/缓冲上限）会以错误回到脚本里，让模型自己看到并决定怎么办——比我们猜一个数字更诚实。
- `MEMORY_LIMIT_BYTES = 2 GiB`（`protocol.ts`）仍是唯一的资源线：VM 堆上限。它不是预留（创建 VM 只占几 MiB，按需增长），只把「超量分配」变成脚本里可捕获的 InternalError 而不是打穿宿主。残留风险：宿主侧在过桥前还要持有 Buffer + 解码字符串（约 2 倍体积），极大文件仍可能把 pi 进程顶到系统的 OOM 边界——那条路没有「让模型看到」的机会，属于已知取舍。
- `fs.write` 接受字符串、`mkdir -p` 父目录（与两套 `Write` 工具一致，虽然 Node 的 `writeFile` 不建目录）。
- 读**不设**工作区限制：仓库里读本来就不设门（`Read` 工具亦然），写入才是被 guard 管的那一侧。

### D6：文件读写工具从脚本可调用集合里排除

`EXCLUDED_TOOL_NAMES` 加上 `Read` / `Edit` / `Write` 与 `read` / `edit` / `write`（两套工具集大小写都要列，注册时名单是固定的字符串集合）。模型直接调用这些工具不受影响，排除只作用于脚本。

理由：脚本有 `fs.read` / `fs.write` 之后，再留着工具那条路就是同一件事的两种语义（行号 + 截断 + 锚点替换 vs 原文整体读写），模型会在两者之间挑错；而为 LLM 上下文设计的行号/截断语义本来就不适合脚本。`Glob` / `Grep` 只读且返回的是「命中清单」，不在本次排除范围内（要不要给它们结构化结果，是后续的事）。

代价：脚本里 `call("Read")` 会直接报「not available」，迁移提示只能靠描述与文档——描述里 `fs` 声明与工具重载并列，模型看得到正确入口。

### D7：归档顺序

本变更的 delta 修改了「工具注册与可调用工具集合」，`codemode-call-structured-results`（已合并、待归档）也改同一条。必须按顺序归档：先同步那个变更的 delta，再归档本变更；否则后者会把前者的「返回类型按 structuredSchema 渲染」那一段覆盖掉。

## Risks / Trade-offs

- [`fs` 不受 `disabledTools` 约束] → 与 `store` 一致；它在 codemode 关闭时自然不存在。文档里写清。
- [脚本不能再 `call("Read" / "Edit" / "Write")`] → 有意的破坏性变化；描述里给出了 `fs` 声明，README 同步。
- [严格程度跟当前文件工具集走] → 见 D2：共享记账意味着 claude-code 下要求先读、opencode 下只管「读过之后不能再被改」；这是为了避免工具与脚本对同一文件给出互相矛盾的判断。
- [大文件读会同时占宿主与 VM 内存（要过 JSON 桥）] → 不设读的上限（见 D5）：放不下时以错误回到脚本；宿主侧那几份拷贝可能顶到系统 OOM 边界，是已知取舍，真嫌重就把 `fs.read` 下移到 worker 里直接读盘。
- [`fs.write` 不做行级替换] → 这是有意的：脚本要整体重写；模型改一行仍然用 `Edit`。
