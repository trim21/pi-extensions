# Design

## Context

动机见 proposal.md。改动前的事实：

`src/lib/file-reads.ts`（180 行）导出：`ReadsState` / `FileSnapshot` / `createReadsState` / `snapshotOf` / `fileDigest` / `digestIfExists` / `readStateKey` / `requireCurrentRead` / `requireUnchangedRead` / `deserializeReads` / `restoreReads`。

记账仪式的 12 个调用点（改动前）：claude-code `files.ts:250-256`（Read 图片）、`288-303`（Read 文本）、`387-402`（Edit 创建）、`453-478`（Edit 替换）、`555-575`（Write）、`642-651`（rename hook）；opencode `files.ts:503-509`（read 图片）、`524-525`（read 文本，指纹来自流式 `fileDigest`）、`671-679`（edit 创建）、`718-734`（edit 替换）、`846-852`（write）、`909-918`（rename hook）。守卫 4 处：claude-code `439-440` / `535-536`（严格）、opencode `705-706`（严格）/ `814-819`（宽松 + `state.reads.has` 短路）。

`readStateKey`（`file-reads.ts:78-87`）：`realpath(filePath)`，ENOENT / ENOTDIR 时回退到原路径。这一回退是给「文件还不存在」的创建路径用的，但它同时意味着 key 会随「文件是否已落盘」而变。

消费者：`src/lib/write-guard.ts` 只用 `snapshotOf` / `digestIfExists`；`src/lib/lsp/rename-tool.ts` 通过 `options.recordReads` 钩子（返回 `Record<string, unknown>`）拿到 details 片段，不直接依赖本模块；测试只 import `deserializeReads` / `createReadsState`。

`resolvePathArg`（`lib/path.ts:55-60`）只做 `~` 与相对路径展开，不解析 symlink——所以经 symlink 目录写入的新文件，其路径在写盘前确实是未解析的。

## Goals / Non-Goals

**Goals:**

- 「记账 key 必须解析成真实路径」这一不变量由模块保证，不再依赖调用点选择算 key 的时机。
- 12 个调用点的三步仪式各收到 1 行；守卫不再手工解析 key。
- 修复 opencode `write` 经 symlink 新建文件后「紧跟的 edit 要求重新 read」这一 bug，并补上此前缺失的回归测试。

**Non-Goals:**

- 不做「读盘 → 校验 → 写盘 → 重新记账 → 产出 details」的写盘事务（见 D1）。
- 不改守卫语义、错误文案、两套工具集的策略差异（claude-code 的 Read/Edit/Write 都要求先读、opencode 只有 edit 要求先读）——这是 `AGENTS.md` 与 `SKILL.md` 明确记录的有意分歧。
- 不改 `details.reads` 的格式与 `restoreReads` 的重放逻辑。
- 不改 `write-guard.ts`（它只用快照计算，与记账 key 无关）。

## Decisions

### D1 只收「记账 + 守卫」，不做持有写盘的写盘事务

报告里的候选写成「把读盘 → 校验 → 写盘 → 重新记账 → 产出 details 收成一个事务模块」，实现前逐站点读完后否决了这个形状：

- **写盘序列的可变部分比共同部分大**：审批（`guardWriteAccess` 需要 `ctx` / `policy` / `signal` / toolName）、BOM 解析（opencode `write` 的 `resolveBom`）、`access` 权限检查、`stat` 分支（claude-code `Write` 的 ENOENT → `didYouMean`、ipynb 拒绝、1GB 上限）、`signal.throwIfAborted()` 的插入位置、diff/patch 生成方式都按工具不同。
- **持有写盘的事务要么把内容传两遍、要么吞掉平台细节**：若事务接收 `nextContent` 又接收一个写盘闭包（闭包内部自行 `writeFile`），则「参与记账的内容」与「真正落盘的内容」是两份可以漂移的输入；若事务自己 `mkdir` + `writeFile`，则必须再接手 `signal` 与 abort 时机（7 个参数），而它替调用点省下的只是每站 3-4 行。
- **接口宽度 ÷ 被隐藏的行为** 是这次取舍的判据：一个 5-7 参数、带审批回调与三种守卫枚举的事务，不比它隐藏的 4 行更小——是浅模块。真正均匀、且真正容易写错的部分只有两块：**key 解析 + 记账**、**守卫的 key 解析**。这两块被完整收进 `file-reads.ts`（D2/D3/D4），而 `readStateKey` 的健壮化（D2）从根上消除了「必须凑成一个函数调用才安全」的理由——时序不再是正确性条件，事务也就没有存在意义。

### D2 `readStateKey` 向上解析到最深的已存在祖先

```ts
export async function readStateKey(filePath: string): Promise<string> {
  const segments: string[] = [];
  let current = filePath;
  for (;;) {
    try {
      return join(await realpath(current), ...segments.reverse());
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      // 走到文件系统根仍不存在：无法解析，回退原路径（等价于旧行为）
      return filePath;
    }
    segments.push(basename(current));
    current = parent;
  }
}
```

- 文件存在时与旧实现完全一致（第一轮 `realpath(filePath)` 成功即返回）。
- 文件不存在时得到「最深已存在祖先的真实路径 + 剩余段」，正是文件落盘后 `realpath(filePath)` 会给出的值（不存在的段里不可能有 symlink）。于是 key 不再随文件是否已落盘而变。
- 边界：`segments.reverse()` 就地反转，每轮只反转一次已 push 的段（循环内不再使用 segments，安全）；`parent === current` 在 POSIX 根（`/`）与 Windows 盘根成立，避免无限循环。
- 备选（否决）：把记账时机固定为「写盘之后」，靠文档约定。它只覆盖已知的调用点，正是本次 bug 的成因；健壮化 key 让不变量由构造保证。

### D3 `recordRead` / `recordReads` 返回 details 片段

```ts
/** 记账这些文件；解析 key、写入 state，返回可直接放进 details 的 reads 片段。 */
export async function recordReads(
  state: ReadsState,
  entries: readonly { path: string; snapshot: FileSnapshot }[],
): Promise<Record<string, FileSnapshot>>;

/** 单文件记账：`recordReads` 的单项形式。 */
export async function recordRead(
  state: ReadsState,
  filePath: string,
  snapshot: FileSnapshot,
): Promise<Record<string, FileSnapshot>>;
```

- 参数收 `FileSnapshot` 而不是内容：`snapshotOf` 已是本模块的公开词汇（`write-guard.ts` 也在用），调用点原本就写 `const snapshot = snapshotOf(content)`——保留这一行，去掉 `readStateKey` / `state.reads.set` / `details` 里的 map 字面量。opencode 的流式读取站点直接给 `{ digest: await fileDigest(path), textEditable: true }`，不必先把整文件读进内存。
- **对象还是 Map**：`ReadsState.reads` 与 `deserializeReads` 用 Map（内存记账、key 查找、分支重放 `clear()`），本函数的返回值用对象——它不是状态，而是 details 的持久化形状。宿主把工具 details 定为 `JsonValue`（pi `packages/agent/src/harness/session/types.ts:38`），session 是 JSONL，Map 序列化过去是 `{}`，记账会在 resume / reload / fork 后静默丢失。若让返回值也做 Map、再加一层序列化，每个调用点都要转一次，且 `recordReads` 会退化成「每个文件造单元素 Map → 合并成大 Map → 再转回对象」的无谓中转。两个形状各自只出现在该出现的地方，转换集中在这一对边界函数上（本函数 ↔ `deserializeReads`）。
- `recordReads` 是唯一实现（直接建对象），`recordRead` 委托给它：两处逐字相同的 rename hook（每处 8 行）收敛成一次调用，单文件站点不必写数组字面量。
- 返回片段而不是 `{ key, snapshot }`：调用点只需要 `reads`（`details: { reads, pendant }`），暴露 key 只会诱导调用点自己去拼 map——那正是要消除的重复。

### D4 守卫改为接收路径

```ts
export async function requireCurrentRead(state, filePath, currentContent): Promise<void>; // 严格
export async function requireUnchangedRead(state, filePath): Promise<void>; // 宽松
```

- 严格版：内部 `readStateKey` → 未读 / 非文本 / 指纹不符三条判定与文案不变（`write-guard.ts`、测试与 `SKILL.md` 依赖这些文案）。
- 宽松版：内部 `readStateKey` → **无记录先短路返回**（保留 opencode `write` 现在用 `state.reads.has(key)` 做的优化：从未读过的文件不做无谓的整文件 digest）→ 否则 `digestIfExists(filePath)` 比指纹，`undefined`（文件已删）同样算过期。
- 名字沿用 `requireCurrentRead` / `requireUnchangedRead`（不改词汇，只去掉调用点的 key 参数）。
- 备选（否决）：让守卫直接接收内容、内部算快照——严格版的 `currentContent` 调用点已经读过磁盘（Edit 需要它做审批预览与 `applyEdit`），再读一遍对大文件是浪费。

## Risks / Trade-offs

- [D2 的祖先链遍历多出几次 `realpath` 系统调用（新建文件路径）] → 只在文件不存在时发生，且路径深度有限；写入路径本身就要做多次 fs 调用。
- [D2 改变了 `readStateKey` 对不存在路径的返回值，可能影响未预料到的调用点] → 公开导出面里只有两套工具集的记账在用；`write-guard.ts` 不 import 它。改造后 12 个调用点统一经 `recordRead` / 守卫使用它。
- [D3/D4 让 `file-reads.ts` 从「能力集合」变成「记账算法的所有者」，模块更重] → 这正是深化：模块的接口（`recordRead` / `recordReads` / 两个守卫 / 重放）比它隐藏的行为（key 解析、时序、细节格式）窄，调用点不再需要知道 key 是怎么来的。
- [写盘路径的改动有数据风险] → 本次不移动任何 `writeFile` / 审批 / abort 的位置，只替换记账与守卫的表达式；两套工具集既有的 read-before-write 用例（含 claude-code 的 symlink 用例、opencode 的 not-read-yet / modified-since-read 用例）必须原样通过。
