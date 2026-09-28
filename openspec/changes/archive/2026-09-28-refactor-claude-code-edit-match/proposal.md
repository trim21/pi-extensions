# Proposal

## Why

claude-code 的 Edit 工具有一份**影子匹配实现**和一份真实匹配实现：

- `src/claude-code/files.ts:186-212` 导出 `exactReplace(content, old, new, replaceAll)`，全仓唯一引用是 `test/claude-code-tools.test.ts:371-374`——`src/` 内零调用者，它唯一的消费者是测试，而测试因此打的是副本。
- 真实匹配写在 `Edit.execute` 里（`files.ts:492-516`）：CRLF 归一后匹配、`replace_all` 语义、以及 `new_string` 为空时的「删除连行尾换行一起删」。
- 两者已经分叉：影子版说 `No changes to apply: old_string and new_string are identical.`，真实版说 `No changes to make: old_string and new_string are exactly the same.`；影子版的未命中错误是 `String to replace not found in file.`，真实版是同一句加上 `\nString: <old_string>`。影子版还完全没有 CRLF 归一与删除语义，所以它连「近似同构」都算不上——它是一份已经过期的复制品。

代价是接口失去测试面：Edit 的匹配语义（唯一性判据、行尾处理、删除语义、错误文案）只能穿过整个工具调用（读文件 → 写盘 → LSP 诊断）间接验证，改一处文案或归一逻辑时，唯一直接对着它写的测试还在打那份副本。

## What Changes

- 新增 `src/claude-code/edit-match.ts`：`applyExactEdit(original, oldString, newString, replaceAll)` 成为 claude-code 风格精确替换的唯一实现（精确匹配、无模糊策略；CRLF 归一后匹配、写回恢复原行尾；`new_string` 为空时吃掉行尾换行；未命中与多重匹配的错误文案原样保留）。
- `Edit.execute` 改调它：读文件、大小检查、写盘、快照、diff、诊断留在原处，只有 `files.ts:487-516` 的匹配段变成一次调用。
- 删除 `exactReplace` 与只被它使用的私有 `countMatches`（`files.ts:173-184`）。
- 测试改为直接打 `applyExactEdit`（替换 `test/claude-code-tools.test.ts:370-375` 那组用例），并补上影子版从未覆盖的 CRLF 与删除语义。
- 修正 `claude-code-tools` spec 的 Implementation 段：现文写「files 与 opencode 风格共用匹配引擎（`src/opencode/edit-engine.ts`）」，但 `files.ts` 从未引用 edit-engine（那条共享只经 `lib/write-guard.ts` 成立：write-guard 用了 edit-engine 的 `applyEdit`/`normalizeToLF`，claude-code 的 Edit 用的是自己的精确匹配）。改为描述真实分工。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无。行为契约不变：匹配语义、错误文案、写入行为都保持原样，只是搬到有测试面的位置；spec 的改动是 Implementation 段的事实纠正，不涉及 Requirement，故 `.openspec.yaml` 标记 `skip_specs: true`。）

## Impact

- 代码：新增 `src/claude-code/edit-match.ts`；`src/claude-code/files.ts` 删除 `exactReplace` 与 `countMatches`，Edit 的匹配段改为一次调用。
- 规范：`openspec/specs/claude-code-tools/spec.md` 的 Implementation 段一句（共匹配引擎的描述）按实际分工改写。
- 测试：`test/claude-code-tools.test.ts` 的匹配用例改打新 module 并补 CRLF / 删除语义；Edit 的端到端用例（读-改-写、诊断、write-guard 审批路径）保持不变。
- 不涉及配置格式、公开 API、依赖或用户可见行为。
