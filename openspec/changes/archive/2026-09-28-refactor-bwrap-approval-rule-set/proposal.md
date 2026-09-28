# Proposal

## Why

审批规则（`approvalRules`）的行为没有一个 owner，同一个判据在三处各写一遍：

- 真正的求值在 `src/bwrap/approval-rules.ts` 的 `evaluateBashApproval`（deny 优先、allow 需全量、重定向不自动放行、`findLast` 后写优先）；
- 审批弹框的子菜单要单独问一遍「这个模式会不会被自动放行」，于是 `src/bwrap/runtime.ts:755-762` 用 `matchRule` + `findLast` 手抄了「后写优先」的那一半（重定向与 deny 完全不参与，判据已经不同）；
- 规则的先后顺序由 `src/bwrap/core.ts:196` 的 `deepMerge`（全局规则在前、项目规则在后）与 `findLast` 共同决定，但没有任何一处声明这件事；
- 「勾选模式持久化」的副作用（读项目配置、追加、写回、刷新缓存）是 `runtime.ts:840` 的私有方法，与求值逻辑分居两文件；
- 嵌套命令的展开（`visit` 递归）在 `approval-rules.ts:231` 与 `approval-suggest.ts:46` 各写一遍。

先例是刚完成的 `refactor-bwrap-invocation-exec`：概念只声明一次、副作用收进一个 module 之后，重复与漂移就没有容身之处。这次同样不是顺手去重——规则集的求值语义、顺序语义、持久化副作用分居三文件，改动一处就要在另外两处再确认一遍。

## What Changes

- `src/bwrap/approval-rules.ts` 新增 `createApprovalRuleSet({ rules, suggestPatterns, persist })`，返回规则集 module：
  - `evaluate(command)`：deny 优先 / 链上命令全部命中 allow 才放行 / 含文件输出重定向不自动放行 / 单条命令上后写规则优先；
  - `isAllowed(pattern)`：同一个「后写优先」判据的查询面，供弹框子菜单判定；
  - `pendingPatterns(command)`：命令的候选模式去重后仍未命中 allow 的那些（子菜单列表的唯一来源）；
  - `addAllowRules(patterns)`：追加 allow 规则并持久化，成功后立即生效。
- 删除 `evaluateBashApproval` 自由函数；规则集取代它（`matchRule`、`parseBashCommands` 等解析/匹配原语保持导出与位置不变）。
- 嵌套命令展开抽成 `flattenCommands`，`approval-rules.ts` 与 `approval-suggest.ts` 共用。
- `src/bwrap/runtime.ts` 只保留「弹框 + 文案」：判定改走 `evaluate`，子菜单改走 `pendingPatterns`，`persistAllowRule` 变成注入给规则集的 `persist` 实现（写项目配置 + 刷新缓存）。
- 规范同步：`bwrap` spec 的「提权审批」补上现有但未写明的行为——链上全部命中才自动放行、单条命令后写优先、含重定向不自动放行、`/bwrap-deny-request` 与固定沙箱下非沙箱请求直接拒绝（规则与弹框都不参与）、勾选的模式写入项目配置并立即生效、子菜单只列未命中 allow 的模式。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap`：「提权审批」由「命中 allow 规则即放行」的粗描述改为规则集的完整判定语义；新增「审批规则的持久化」需求（勾选模式写入项目配置、立即生效、保留配置文件中其余内容）。

## Impact

- 代码：`src/bwrap/approval-rules.ts`（规则集 module + `flattenCommands`）、`src/bwrap/approval-suggest.ts`（改用共用展开）、`src/bwrap/runtime.ts`（消费规则集、`persistAllowRule` 降级为注入的持久化实现）。
- 规范：`openspec/specs/bwrap/spec.md`（提权审批 Requirement 改写 + 新增持久化 Requirement + Implementation 段的审批描述）。
- 测试：`test/approval-rules.test.ts`（求值改走规则集，补 `isAllowed` / `pendingPatterns` / `addAllowRules` 契约）、`test/bwrap-runtime.test.ts` 现有审批用例应逐条保持通过（行为不变）。
- 行为不变：不涉及配置格式、审批文案、规则匹配语义（`matchRule` 与 tree-sitter 解析）或依赖变更。唯一新增的用户可见行为是：项目配置文件形状非法时持久化会给出明确错误，而不是写入一个后续加载必失败的条目。
