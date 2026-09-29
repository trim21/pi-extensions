# Tasks

## 1. `src/lib/file-reads.ts`

- [x] 1.1 `readStateKey` 改为向上解析最深的已存在祖先（文件存在时行为不变；不存在时返回「已存在祖先的真实路径 + 剩余段」），保留 `isMissingPath` 判定与原路径回退作为到根仍不存在的兜底。验证：`tsc --noEmit`。
- [x] 1.2 新增 `recordReads(state, entries)`（唯一实现：解析 key → `state.reads.set` → 建 details 片段）与 `recordRead(state, filePath, snapshot)`（委托前者）；注释写明这一侧为什么是对象而不是 Map（details 是 `JsonValue`、session 是 JSONL）。验证：`tsc --noEmit`。
- [x] 1.3 `requireCurrentRead` 改为 `(state, filePath, currentContent)`、`requireUnchangedRead` 改为 `(state, filePath)`（内部解析 key；宽松版保留「无记录先短路」再 `digestIfExists`），错误文案与三条判定不变。验证：`tsc --noEmit` + 既有测试通过。

## 2. 调用点

- [x] 2.1 `src/claude-code/files.ts`：5 处记账改为 `const reads = await recordRead(...)` 并在 details 里用 `reads`；2 处守卫改为 `await requireCurrentRead(state, filePath, content)`；`Write` 的 `let key` / `key ??` 与 `resolvedKey` 一并删除；rename hook 改为一次 `recordReads(state, applied.map(...))`；import 去掉 `readStateKey`。验证：`tsc --noEmit`。
- [x] 2.2 `src/opencode/files.ts`：同上（read 文本站点用 `recordRead(state, absolutePath, snapshot)`，保留「指纹先于分页读取」的注释；`write` 的守卫改为 `requireUnchangedRead(state, absolutePath)`，删除 `state.reads.has(key)` 前置判断；`write` 的记账移到 `writeFile` 之后，让记录的指纹描述真的落盘了的内容——写失败时不会留下指向未写入内容的记录）；import 去掉 `readStateKey` / `digestIfExists`。验证：`tsc --noEmit`。
- [x] 2.3 无残留：`grep -rn "readStateKey\|state.reads.set" src/claude-code src/opencode` 输出为空（`readStateKey` 只在 `file-reads.ts` 内部使用）。

## 3. 测试

- [x] 3.1 新增 `test/file-reads.test.ts`（14 个用例）：`readStateKey`（已存在文件 = realpath；未落盘文件 = 落盘后的 realpath 值，含 symlink 目录；父目录缺失时经最深已存在祖先生成）；`recordRead` / `recordReads` 的 key 与返回片段；`requireCurrentRead` 的未读 / 二进制 / 已改动三条拒绝与文案，以及正常通过（含经 symlink 记录、经真实路径校验）；`requireUnchangedRead` 的「无记录放行 / 已改动拒绝 / 文件被删拒绝 / 未变通过」。
- [x] 3.2 回归测试（先失败后通过）：`test/opencode-edit.test.ts` 新增「经 symlink 目录 write 新建文件后紧跟 edit」用例，并确认它在修复前失败——把 `readStateKey` 与记账顺序临时复原成旧实现后，该用例报 `File has not been read yet. Read it first before writing to it.`（正是被报告的症状）；修复后通过。`test/file-reads.test.ts` 的「resolves a not-yet-written file…」用例同样在旧 `readStateKey` 下失败。
- [x] 3.3 `node_modules/.bin/vitest run test/file-reads.test.ts test/opencode-write.test.ts test/opencode-edit.test.ts test/opencode-read.test.ts test/claude-code-tools.test.ts` 通过（170 passed）；`pnpm test` 全套通过（82 files passed / 1 skipped，1245 passed / 6 skipped）。

## 4. 收尾

- [x] 4.1 `prettier --write` 改动文件，`pnpm check`（tsc + prettier --check）与 `pnpm lint` 全绿（exit 0）。改动范围（`git diff --numstat HEAD`）：`src/lib/file-reads.ts`（+61/-20）、`src/claude-code/files.ts`（+22/-36）、`src/opencode/files.ts`（+24/-37）、`test/opencode-edit.test.ts`（+33/-1）、新增 `test/file-reads.test.ts`（200 行）、openspec change 目录。净行数：`src` 约 -21。
- [x] 4.2 报告：行为变化仅一处（symlink 目录下新建文件的记账 key 与记录时机）；`details.reads` 格式（对象、键为 realpath）与 `restoreReads` 重放逻辑不变；残余风险见 design.md 的 Risks（`readStateKey` 对不存在路径多几次 `realpath`；`file-reads.ts` 承担了记账算法本身）。
