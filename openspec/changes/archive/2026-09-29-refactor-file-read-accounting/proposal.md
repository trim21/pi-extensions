# Proposal

## Why

`src/lib/file-reads.ts` 的记账仪式（`snapshotOf` → `readStateKey` → `state.reads.set` → `details.reads`）在 12 个调用点各写一遍——两套工具集各 5 处（Read 图片 / Read 文本 / Edit 创建 / Edit 替换 / Write），外加两个入口文件里逐字相同的 `recordReads` 循环（lsp-rename 一次改动多个文件）。另有 4 处守卫先手工解析 key 再调用 `requireCurrentRead` / `requireUnchangedRead`。

仪式本身不是问题，问题是它携带一个**只写在注释里的时序不变量**：`readStateKey` 用 `realpath` 解析 symlink，文件尚不存在时（ENOENT）回退到未解析路径。所以 key 必须在文件落盘之后再算。claude-code 遵守了这条（`Write` 里 `key ?? await readStateKey(filePath)` 带注释说明、`Edit` 创建分支在 `writeFile` 之后算 key），opencode 的 `write` 违反它——在写盘**之前**算 key（`opencode/files.ts:814`，注释「写后记账（key 在写入前已算过）」）。后果：

- 经 symlink 目录 `write` 一个**新**文件时，记账落在未解析路径下。随后的 `edit` 用 `realpath` 解析出另一个 key，查不到记录，报 `File has not been read yet. Read it first before writing to it.`——模型刚写的文件却必须重新 `read`。
- `details.reads` 里留下一条无人会查的孤儿记录（`restoreReads` 重放它也无用）。
- 现有测试没有覆盖：`test/opencode*.test.ts` 无 symlink 用例，仓库也没有 `test/file-reads.test.ts`（该模块只在两个工具集的测试与 `deserializeReads` 的用例里被间接覆盖）。

## What Changes

- **根因修复**：`readStateKey` 在文件（或其某级父目录）尚不存在时，向上找到最深的已存在祖先目录、`realpath` 之后把剩余路径段拼回，使「写盘前」与「写盘后」算出的 key 一致。时序不变量消失，调用点不再需要关心算 key 的时机。
- **仪式收进模块**：新增 `recordRead(state, filePath, snapshot)` 与 `recordReads(state, entries)`，内部解析 key、写入 state，并返回可直接放进工具 `details` 的 `reads` 片段；12 个调用点各自变成 1 行，`details.reads` 的 key 与模块内部记账的 key 不可能再不一致。
- **守卫不再手工解析 key**：`requireCurrentRead(state, filePath, currentContent)` 与 `requireUnchangedRead(state, filePath)` 接收路径（原为已解析的 key + 当前指纹），内部解析 key；宽松版把「无记录直接放行」的短路与 `digestIfExists` 读盘也收进去，调用点不再需要 `state.reads.has(key)` 的前置判断。
- 效果：记账与守卫的 key 解析只剩 `file-reads.ts` 一处；新增一个会写盘的工具时不会再有「忘了在落盘后算 key」这一类错误。
- **行为变化仅一处**（即上述 bug 修复）：经 symlink 目录新建的文件，其记账现在落在真实路径下，后续 `edit` 不再要求重新 `read`。其余行为（守卫语义、错误文案、两套工具集的策略差异、`details.reads` 的格式与重放）不变。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无。修复的是「记账 key 用 realpath」这一实现内部事实；`lsp-rename` spec 的「写盘安全与记账」要求（更新受影响文件的已读快照、模型无需重新 Read 即可继续 Edit）语义不变，其余 spec 未描述记账 key 的解析方式，因此 `.openspec.yaml` 标记 `skip_specs: true`。）

## Impact

- 代码：`src/lib/file-reads.ts`（新增 2 个函数、2 个守卫改签名、`readStateKey` 改为向上解析）、`src/claude-code/files.ts`（5 个调用点 + rename hook 简化）、`src/opencode/files.ts`（5 个调用点 + rename hook 简化，含 `write` 的 key 时序修复）。
- 测试：新增 `test/file-reads.test.ts`（`readStateKey` 的时序/ symlink 回归、`recordRead` / `recordReads`、两个守卫的策略），并补一条工具级回归（经 symlink 目录 `write` 新建文件后紧跟 `edit` 不要求重新 read）。现有用例全部保持通过（守卫文案与两套工具集的差异不变）。
- 不涉及配置格式、公开 API、依赖、spec 行为。
