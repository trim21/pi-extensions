# Design

## Context

现状（行号取自重构前）：

- `src/claude-code/files.ts:173-184` 私有 `countMatches`（`indexOf` 循环计数）。
- `files.ts:186-212` 导出 `exactReplace`：检查 `old === new`、`old === ""`、未命中、多重匹配（`replace_all` 为 false 时），然后 `split/join` 或 `slice` 拼接。src 内零调用者，唯一引用是 `test/claude-code-tools.test.ts:371-374`。
- `Edit.execute` 的真实路径：`files.ts:404-448` 处理 `old_string === ""`（创建 / 填充空文件，无需先 Read），`files.ts:449-462` 大文件上限，`files.ts:463-484` 读取与 read-before-write 校验，`files.ts:485-524` 才是匹配与写盘：
  - `lineEnding = crlfCount > lfCount ? "\r\n" : "\n"`，`normalized = original.replaceAll("\r\n", "\n")`；
  - `matches = normalized.split(oldString).length - 1`，未命中抛 `String to replace not found in file.\nString: ${oldString}`，多重匹配且 `replace_all` 为 false 时抛带 `\nString: ${oldString}` 的那条；
  - 删除语义：`new_string === ""` 且 `old_string` 不以换行结尾且 `normalized.includes(oldString + "\n")` 时，`searchString = oldString + "\n"`；
  - `replaceAll ? normalized.split(searchString).join(newString) : normalized.replace(searchString, () => newString)`（函数替换避免 `$&` 语义）；
  - 最后按 `lineEnding` 还原行尾。
- `src/lib/write-guard.ts:23` 从 `src/opencode/edit-engine.ts` 引入 `applyEdit` / `normalizeToLF`——opencode 风格与 write-guard 确实共用匹配引擎，但 claude-code 的 Edit 用的是自己的精确匹配（Claude Code 语义：必须精确且唯一，没有 edit-engine 的 8 种模糊策略）。

## Goals / Non-Goals

**Goals:**

- Edit 的匹配语义只有一个实现，且它是被测试直接打的那个（interface 即测试面）。
- 删除 `exactReplace` 这份已分叉的影子实现与只服务它的 `countMatches`。
- 错误文案只有一份来源。
- 匹配语义（唯一性、CRLF、删除行为）可直接单测，不必穿过写盘与 LSP 诊断。

**Non-Goals:**

- 不改 Edit 的任何可观察行为：文案、CRLF 处理、删除语义、`replace_all` 语义、写盘、快照、diff、诊断流程都不动。
- 不把 claude-code 的 Edit 改成 edit-engine 的模糊匹配（那是行为变更：edit-engine 有 8 种容错策略、BOM 处理与 disproportionate-match 守卫，与 Claude Code 的精确匹配契约冲突）。
- 不给 claude-code 引入 edit-engine 的行尾/BOM 辅助函数（只用本模块自己的 CRLF 归一，语义与今天逐字一致）。
- 不动 opencode 侧任何代码。

## Decisions

### D1 新 module 是纯函数，落在 `src/claude-code/edit-match.ts`

```ts
/**
 * Claude Code 风格的精确替换：只做精确字符串匹配（无模糊策略）。匹配在 CRLF 归一后
 * 进行，写回时恢复原文行尾；new_string 为空且 old_string 不以换行结尾时，连同
 * 紧随其后的换行一起删除，避免留下空行。
 *
 * 抛错文案是工具契约的一部分（Claude Code 兼容），改动前先看
 * test/claude-code-tools.test.ts 的断言。
 */
export function applyExactEdit(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string;
```

- **参数与返回值**：`original` 是文件当前内容（UTF-8 已解码），返回值是替换后、行尾已还原的完整内容。调用方负责读写盘、快照、diff 与诊断。
- **为什么不接收 Buffer 或文件路径**：那是「工具」的职责，不是匹配的职责；保持纯函数才能直接喂字符串序列。
- **`replaceAll` 必填**：调用方本来就有 `params.replace_all ?? false`，必填让模块不猜默认值。
- **考虑过的替代方案**：
  - 把 `applyExactEdit` 留在 `files.ts` 里导出（同文件、改动最小）：`files.ts` 已经 740 行、同时装着 Read/Edit/Write/lsp-rename 四个工具的注册逻辑，匹配语义（CRLF、删除、唯一性、错误文案）与这些没有共同状态；独立文件让「改匹配语义」的落点唯一且不牵动工具注册代码。选独立文件。
  - 让 claude-code 直接调用 `edit-engine.applyEdit`（让 spec 的「共用匹配引擎」成立）：会引入模糊匹配与 BOM 行为，是行为变更，且与 Claude Code 兼容契约冲突。否决，改为修正 spec 文字（D4）。
- **`oldString === newString` 与 `oldString === ""` 的检查不进模块**：前者在 `files.ts:404-406`、后者是创建/填充分支（`files.ts:408-448`），都在匹配之前且带工具语义（写盘、提示文案）。模块只处理非空 `old_string` 的替换，文档注释里写明这一点。

### D2 匹配段整体搬迁，判定顺序与文案逐字保留

模块内部顺序必须是：计算 `lineEnding` → `normalized` → `matches` 计数 → 未命中抛错 → 多重匹配抛错 → 删除语义的 `searchString` → 替换 → 还原行尾。三处文案逐字照抄（含 `\nString: ${oldString}` 与 `please provide more context to uniquely identify the instance.`）。

### D3 删除 `exactReplace` 与 `countMatches`

`countMatches` 只被 `exactReplace` 使用，随它一起删除；真实路径用的是 `split().length - 1`，模块沿用后者以保持行为一致（两者在重叠匹配的计数上等价，因为 `split` 与 `indexOf` 循环都按不重叠推进——但既然 `split` 是当前真实路径的行为，就不要再引入第二种计数方式）。

### D4 spec 只改 Implementation 那句

`openspec/specs/claude-code-tools/spec.md:73` 现文「与 opencode 风格共用匹配引擎（`src/opencode/edit-engine.ts`）与写保护（`src/lib/write-guard.ts`）」中的前半句与代码不符：claude-code 的 Edit 从不引用 edit-engine。改为：匹配在 `src/claude-code/edit-match.ts`（精确匹配，Claude Code 语义），写保护经 `src/lib/write-guard.ts`（该文件复用 edit-engine 的 `applyEdit` / `normalizeToLF`）与 opencode 侧共享。这是 Implementation 段的事实纠正，不新增/修改 Requirement，因此本 change 标 `skip_specs: true`。

## Risks / Trade-offs

- **模块只覆盖「非空 old_string」的替换**：读模块的人可能误以为它管全部 Edit 语义。文档注释必须写明「空 `old_string`（创建/填充）与 `old_string === new_string` 的判定在调用方」。
- **`normalized.split(searchString).length - 1` 与旧影子实现的 `countMatches` 在重叠模式上不同**：模块沿用真实路径的 `split` 计数，因此影子版的测试用例（`exactReplace("hello", " hello", "x")` 之类）迁移时要按真实语义重新表述，不能直接照搬断言。
- **文案是契约**：三条错误文案与成功路径都不许在搬迁中「顺手改善」，否则会与 Claude Code 兼容性不符。tasks 里用逐字对照的方式校验。
