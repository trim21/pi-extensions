# Design

## Context

现状（行号取自改前）：

- `src/lib/write-guard.ts:61-137`：`PendingChange` 是 `{kind:"write",newText}` / `{kind:"edit",oldText,newText,apply}`，`buildDiffPreview` 自己 `readFile` 再调 `change.apply(fileContent)` 定位，失败退回参数 diff。`guardWriteAccess`（`:176-238`）在 `:207` 调用它。
- 五个调用点都在写锁**之外**调 `guardWriteAccess`，锁内读盘：Claude Code `Edit`（`files.ts:348` 审批 / `:373` 队列 / `:459-461` 读+算+写）、Claude Code `Write`（`:535` / `:542` / `:550-562`）、opencode `edit`（`files.ts:635` / `:656` / `:704-710`）、opencode `write`（`:813` / `:822` / `:838-855`）、`lsp-rename`（`rename-tool.ts:198` 审批 / `:216` 队列写）。
- 读盘所得到的「旧内容」在每个调用点都已经存在：Claude Code `Edit` 的 `original`（`:459`）、Claude Code `Write` 的 `original`（`:553`）、opencode `edit` 的 `rawContent`（`:704`）、`lsp-rename` 的 `fileEdit.oldText`（由 `expandWorkspaceEdit` 读盘得到）。只有 opencode `write` 例外：它只读前 3 字节判 BOM（`:836-851`）。
- 指纹工具在 `src/lib/file-reads.ts`：`snapshotOf(content)`、`digestIfExists(path)`（流式 sha256，文件不存在返回 undefined）。

## Goals / Non-Goals

**Goals:**

- 审批展示的就是将要写入的内容，写入的就是被批准的这份内容——不再有第二份计算。
- `lib/write-guard.ts` 不知道任何匹配语义，也不为预览读盘。
- 用户停留在对话框期间文件被外部改动时，不覆盖别人的改动。

**Non-Goals:**

- 不改匹配算法、写盘内容、BOM/行尾处理、快照与记账、LSP 诊断、错误文案、审批交互（选项、取消、deny、headless、Windows）。
- 不改 `web_fetch` 的流式落盘（它不进内存，保持只按路径审批）。
- 不为「大文件预览」新增读取上限（沿用现状：审批即展示完整 patch，超过 100 行截断显示）。

## Decisions

### D1 `FileMutation { contentOld, contentNew }` 取代 `PendingChange`

```ts
/** 待审批的写入：内容由调用方算好，批准后按 contentNew 落盘。 */
export interface FileMutation {
  /** 变更前的完整文件内容（文件不存在时为 ""）。 */
  readonly contentOld: string;
  /** 变更后的完整内容——即批准后写进磁盘的字节。 */
  readonly contentNew: string;
}
```

- `contentOld` / `contentNew` 都取**文件原始内容**（含 BOM、保留原行尾），而不是匹配引擎的中间产物：这样「预览」就是磁盘前后的真实对照，且下面 D3 的指纹校验与磁盘字节逐字节对得上。opencode `edit` 因此传 `rawContent` 与 `applied.finalContent`（而不是 BOM 已剥离的 `applied.contentOld/contentNew`）。
- 替代方案：保留 `apply` 注入但只调用一次并把结果复用给落盘。否决——调用方仍可能在落盘时重算，接口层面挡不住；且「预览」与「写盘」之间多一个必须手工保持同步的约定。
- 替代方案：只传 `contentNew`，由写保护自己读盘取旧内容。否决——多一次读，且审批与工具读到的可能不是同一份。

### D2 预览渲染是纯函数

```ts
export function renderMutationPreview(resolvedPath: string, mutation: FileMutation): string;
```

`guardWriteAccess` 在审批分支里调用它。删除 `buildDiffPreview` 的 async / readFile / try-catch / 参数 diff 兜底：拿不到前后内容就不再是渲染问题，而是工具自己的错误（见 D5）。LF 归一保留在渲染侧（CRLF 文件的 diff 每行都带 `\r`）。

### D3 批准后校验指纹

用户可能停留在对话框上几分钟，这段时间文件可能被外部改动——按批准时那份 `contentOld` 算出的 `contentNew` 会覆盖掉它。因此在「Approve once」之后、返回之前重新取一次磁盘指纹：

```ts
const current = (await digestIfExists(path)) ?? EMPTY_DIGEST; // 文件不存在视作空内容
if (current !== snapshotOf(mutation.contentOld).digest) throw new Error(MODIFIED_MESSAGE);
```

- 「不存在」与「空内容」等价，避免「新建文件」在两次判断间被误判为改动（`contentOld === ""` 且文件仍不存在时必须放行）。
- 只在审批分支（真的有对话框）执行；工作区内自动放行的窗口是微秒级，不加这次读。
- 复用 `requireCurrentRead` / `requireUnchangedRead` 的同一句文案。
- 替代方案：不做校验，直接写。否决——那是把「准确的预览」换来「无声覆盖」，与仓库现有的读记账语义相反。

### D4 审批移进写锁（`lsp-rename` 例外）

单文件的四个调用点（Claude Code `Edit` / `Write`、opencode `edit` / `write`）都改成在 `withFileMutationQueue` 内「读盘 → 校验读记账 → 算最终内容 → 审批 → 写」。

- 批准与落盘之间不再有本进程的写入机会（D3 的校验只需要防外部改动）。
- 顺带修掉现有顺序问题：今天先弹审批框、批准后才在锁内做读记账校验，用户可能批准一个随后被拒的改动。现在「未读过 / 已改动 / 太大 / 文件不存在」都在弹窗之前报出。
- 代价：对话框期间该路径的写队列被占用，同路径的其它写入（含 pi 宿主自己的 edit/write）排队。发起这次调用的模型本就卡在对话框上，实际只影响同一轮里并发写同一文件的调用。
- 副作用顺序保持：Claude Code `Edit` 的空 `old_string` 分支里，`mkdir` 仍放在审批之后，避免「先建目录再被拒」。

`lsp-rename` 保持「先逐个文件审批、再逐个写盘」（审批仍在写队列之外）：一次 rename 会改多个文件，把审批塞进「审批一个写一个」的循环会让用户在第二个文件上点 Block 时留下半个 rename，比整体失败更糟。它的前后内容已由 `expandWorkspaceEdit` 在内存里算好，审批展示的仍是将要写入的内容；对话框期间的外部改动由 D3 的指纹校验兜住，而这段时间本进程不会再写这些文件（写盘循环在审批循环之后）。

### D5 匹配失败在弹窗之前报错

`applyExactEdit` / `applyEdit` 抛错（未命中、多重匹配）现在直接成为工具错误，不再退化成参数 diff 让用户批准一个写不进去的改动。参数 diff 这条兜底路径连同它的测试一起删除。

### D6 opencode `write` 的整读

它的 `contentOld` 需要文件内容，而现状只读 3 字节判 BOM。改为整读一次（`readFile` 返回 Buffer，BOM 判定仍用它的前 3 字节，`resolveBom` 的签名不变），`contentOld = buffer.toString("utf8")`。

- 代价：工作区内、且读记账里没有该文件的 `write` 会多一次整读（Claude Code `Write` 与两个 `Edit` 本来就在整读）。
- 替代方案：只在需要弹窗时才算 `contentOld`（给 `mutation` 传 thunk 或先问 `needsApproval`）。否决——为省一次读引入一个必须与守卫判定保持一致的公共 seam，得不偿失。

## Risks / Trade-offs

- [审批占用写锁] → 只影响同路径写入；被阻塞的一方本来也要排在同一个写队列后面。若将来出现对话框长期不响应导致的排队投诉，可把审批退回锁外并保留 D3 的指纹校验。
- [指纹校验多一次流式读] → 只发生在真的弹了对话框的路径上，与今天「预览自己读一次」的开销同级。
- [`contentOld` 含 BOM 时 diff 首行带不可见字符] → 仅当首行同时改动才可见；换来的是预览与磁盘逐字节同源、指纹校验精确。
- [opencode `write` 的整读] → 见 D6 的替代方案与代价说明。
- [文案「modified since read」用于「批准期间被改动」] → 同一句文案覆盖两种时序，语义一致（都是「磁盘不是你看过的那份」），不新增用户可见文案。

## Migration Plan

无。纯内部重构，无配置或数据迁移；回滚即还原这几个文件。
