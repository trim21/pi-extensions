# Tasks

## 1. 规则集 module

- [x] 1.1 `src/bwrap/approval-rules.ts`：把 `evaluateBashApproval` 的求值逻辑（命令树展平 → 逐条 `findLast` 匹配 → deny 优先 / allow 需全量 / 重定向不自动放行）搬进 `createApprovalRuleSet` 的 `evaluate`，删除自由函数 `evaluateBashApproval`；验证：`pnpm exec tsc --noEmit` 通过，`grep -n "evaluateBashApproval" src/` 无匹配。
- [x] 1.2 同文件实现 `isAllowed(pattern)`（与 `evaluate` 共用「最后一条匹配规则」判据）与 `pendingPatterns(command)`（`suggestPatterns` 去重后过滤未覆盖项）；验证：新增单测覆盖「allow 覆盖后 `isAllowed` 为 true、被后写 deny 覆盖后为 false」「`pendingPatterns` 去重且剔除已允许项」。
- [x] 1.3 同文件实现 `addAllowRules(patterns)`：构造 `{ action: "allow", pattern }` → `await persist(rules)` → 并入内部视图（`rules()` getter 立即看到）；验证：单测断言 persist 收到的规则、persist 抛错时不生效、成功后 `isAllowed(pattern)` 变 true。
- [x] 1.4 抽出并导出 `flattenCommands(parsed)`，`evaluate` 与 `approval-suggest.ts` 的 `patternsFromCommands` 共用，删掉后者自己那份 `visit` 递归；验证：`pnpm exec vitest run test/approval-rules.test.ts test/approval-suggest.test.ts` 通过。

## 2. runtime 侧接线

- [x] 2.1 `src/bwrap/runtime.ts`：`execute` 用 `createApprovalRuleSet({ rules: () => this.resolve(ctx).approvalRules, suggestPatterns: commandPatternsFor, persist: (rules) => this.persistAllowRules(ctx, rules) })` 创建规则集，自动判定改走 `ruleSet.evaluate(request.command)`；验证：`pnpm exec vitest run test/bwrap-runtime.test.ts` 通过，且 `grep -n "evaluateBashApproval\|matchRule" src/bwrap/runtime.ts` 无匹配。
- [x] 2.2 `approveFullAccessUI` 的子菜单改走 `await ruleSet.pendingPatterns(command)`（删掉内联的 `findLast` + `matchRule` 过滤与 `Set` 去重）；验证：`test/bwrap-runtime.test.ts` 的「shows only unallowed patterns in the edit submenu when part of a chain is pre-approved」逐字不改地通过。
- [x] 2.3 四个决策分支里的 `persistAllowRule(...)` 改为 `ruleSet.addAllowRules(...)`，`persistAllowRule` 变成注入实现（只做「写项目配置 + 刷新 `resolved.approvalRules`」，函数名与注释相应更新）；验证：`pnpm exec vitest run test/bwrap-runtime.test.ts` 中四条持久化用例（allow once / deny / deny with reason / edit 子菜单）通过，落盘内容与断言不变。
- [x] 2.4 持久化实现读项目配置时补 `Value.Check(bwrapConfigFileSchema, raw)` 校验：形状非法时抛 `Invalid bwrap configuration at <path>: ...`（cause 保留原错误），合法时保持「原对象 + 追加 rules」的写回语义；验证：新增单测（项目配置文件写入非法 `approvalRules` 形状 → 追加时报错且文件内容不变），并确认合法文件里与规则无关的字段（含不认识的字段）写入后仍在。

## 3. 测试

- [x] 3.1 `test/approval-rules.test.ts`：`evaluateBashApproval` 的用例改走 `createApprovalRuleSet({ rules: () => rules, suggestPatterns: commandPatternsFor, persist: async () => {} })`，断言值保持不变（allow 需全量、deny 优先、管道与嵌套命令、重定向不自动放行、后写优先）；验证：`pnpm exec vitest run test/approval-rules.test.ts` 通过。
- [x] 3.2 新增「规则集语义」用例：单条命令同时命中 allow 与 deny 时后者（数组靠后）胜出、`pendingPatterns` 与 `isAllowed` 的一致性；验证：先临时把 `findLast` 换成 `find` 确认该用例失败（证明断言有牙齿），再恢复实现后通过。

## 4. 规范与验证

- [x] 4.1 `openspec/specs/bwrap/spec.md` 的 Implementation 段「审批」条目按新结构改写（规则集 module + 注入的持久化实现），涉及文件列表不变；验证：逐条与 `src/bwrap/approval-rules.ts`、`src/bwrap/runtime.ts` 的实际调用路径对照。
- [x] 4.2 `pnpm check`（`tsc --noEmit` + `prettier --check`）与 `pnpm lint` 全绿（prettier 在改动完成后统一跑一次）。
- [x] 4.3 `pnpm test` 全量通过；`pnpm exec vitest run test/bwrap-runtime.test.ts test/approval-rules.test.ts test/approval-suggest.test.ts test/bwrap-config.test.ts test/bwrap-write-guard.test.ts` 无回归。
- [x] 4.4 `openspec validate refactor-bwrap-approval-rule-set --strict` 通过。
