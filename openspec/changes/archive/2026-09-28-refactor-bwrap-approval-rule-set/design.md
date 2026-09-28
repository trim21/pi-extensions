# Design

## Context

审批规则的现状（`refactor-bwrap-invocation-exec` 之后）：

- `src/bwrap/approval-rules.ts`：tree-sitter 解析（`parseBashCommands`）、通配匹配（`matchRule`）、求值（`evaluateBashApproval(command, rules)` 自由函数）。
- `src/bwrap/approval-suggest.ts`：BashArity 建议模式（`commandPattern` / `commandPatternsFor`），自己不展平命令树而是又抄了一遍 `visit` 递归。
- `src/bwrap/runtime.ts`：`execute` 用它做自动判定；`approveFullAccessUI` 用 `matchRule` + `findLast` 重问一遍「这个模式会不会自动放行」；`persistAllowRule` 读项目配置、追加规则、写回文件并把新规则追加进缓存的 `resolved.approvalRules`。
- 规则顺序：`core.ts` 的 `deepMerge` 把项目规则接在全局规则之后，`findLast` 让后写者胜出；没有任何一处声明这个契约。
- 依赖方向：`approval-suggest.ts` → `approval-rules.ts`（单向）。若让 `approval-rules.ts` 反向 import 建议逻辑就会成环，这是 `refactor-bwrap-invocation-exec` 里同一个问题的翻版。

## Goals / Non-Goals

**Goals:**

- 「一条命令会不会被自动放行」「允许/拒绝/交人审」「勾选的模式怎么落盘」由一个 module 独占，调用方只描述用户动作。
- 规则顺序契约（后写优先、项目在全局之后）在 module 的接口上写明，而不是隐含在 `deepMerge` + `findLast` 的组合里。
- 命令树展平只有一份实现。
- 现有行为逐条不变，`test/bwrap-runtime.test.ts` 的审批用例除内部构造外不需要改断言。

**Non-Goals:**

- 不改 `matchRule` 的通配语义、tree-sitter 解析、`arity.json` 的 BashArity 表。
- 不改审批 UI 的文案、选项、两层菜单结构。
- 不改配置格式与 `deepMerge` 的合并规则。
- 不给规则集加缓存、索引或异步批处理等性能手段（命令解析本身是既有成本）。

## Decisions

### D1 规则集作为工厂返回的闭包 module，放在 `approval-rules.ts`

```ts
export interface ApprovalRuleSetOptions {
  /** 当前规则（读取时取最新，追加后无需重建规则集）。规则数组即优先级：靠后优先。 */
  rules: () => readonly ApprovalRule[];
  /** 命令 → 候选模式（BashArity），注入以免与 approval-suggest.ts 成环。 */
  suggestPatterns: (command: string) => Promise<readonly string[]>;
  /** 追加 allow 规则并持久化；resolve 后 rules() 必须能看到它们。 */
  persist: (rules: readonly ApprovalRule[]) => Promise<void>;
}

export interface ApprovalRuleSet {
  evaluate(command: string): Promise<ApprovalAction | undefined>;
  isAllowed(pattern: string): boolean;
  pendingPatterns(command: string): Promise<string[]>;
  addAllowRules(patterns: readonly string[]): Promise<void>;
}

export function createApprovalRuleSet(options: ApprovalRuleSetOptions): ApprovalRuleSet;
```

- **为什么 `rules` 是 getter 而不是数组**：`runtime.resolved` 会被 `setMode` / `/bwrap-reload` 替换，持久化也会追加规则；getter 让规则集永远看到当前值，调用方不必在规则变化后重建它。
- **为什么注入 `suggestPatterns`**：`pendingPatterns` 需要候选模式，而建议逻辑在 `approval-suggest.ts`，后者依赖 `approval-rules.ts` 的解析函数。注入让依赖方向保持单向（`runtime` → `approval-rules` → 注入点），也把这部分从「真跑 tree-sitter」变成测试里可替换的输入。
- **考虑过的替代方案**：
  - 把规则集放进新文件 `approval-set.ts`：文件多一层但没换来更小的接口，且 `evaluate` 与 `matchRule`/`parseBashCommands` 分家后，改求值语义要在两个文件间跳。否决。
  - 把 `approval-suggest.ts` 合并进 `approval-rules.ts` 以消环：删除 test 里 `commandPatternsFor` 的导入位置、`arity.json` 也要跟着搬，改动面大于收益（deletion test 上它是 move 而非 concentrate）。否决。
  - 保留自由函数 `evaluateBashApproval` 并另加规则集外壳：两个入口意味着两条路径，正是本次要消除的形态。否决，直接以规则集取代自由函数。

### D2 `isAllowed` 与 `evaluate` 共用「后写优先」判据

`isAllowed(input)` 回答「这个字符串（命令原文或候选模式）是否命中最后一条匹配的 `allow` 规则」，内部与 `evaluate` 的每命令判定同源。弹框子菜单据此只列未覆盖的模式，不再自己写 `findLast` + `matchRule`。两者语义差异（`evaluate` 还要看 deny、重定向、全链）保留在 `evaluate` 内，接口文档写明 `isAllowed` 只回答 allow 覆盖。

### D3 `pendingPatterns` 是子菜单列表的唯一来源

`pendingPatterns(command)` = `suggestPatterns(command)` 去重后过滤掉 `isAllowed` 的模式。去重与过滤属于规则集语义（「还没有被允许的模式」），不留在 UI 层。

### D4 `addAllowRules` 是唯一的追加路径，持久化由调用方注入

规则集构造 `{ action: "allow", pattern }[]` → `await persist(rules)` → 成功后并入内部视图（经 `rules()` getter 自然可见）。`persist` 抛错即视为未追加。runtime 侧的实现就是原来的 `persistAllowRule`：写 `.pi/sandbox.json`（保留文件中其余内容，包括不认识的字段）+ 更新缓存的 `resolved.approvalRules`。文件读写的知识留在 runtime（它已经持有 cwd 与缓存），规则集不碰 fs。

### D5 配置文件读写补一次 schema 校验

`persist` 实现读项目配置文件时，除现有的「不透明保留其余字段」外，用 `Value.Check(bwrapConfigFileSchema, raw)` 校验一次：形状非法时抛出可定位的错误，而不是把新规则追加进一个后续加载必然失败的文件。写入内容仍是「原对象 + 追加的 rules」，不经过 schema 往返，避免丢掉不认识的字段。该文件在会话开始时已通过 `loadBwrapConfig` 校验，因此这条路径只在配置文件被中途改坏时触发。

### D6 `flattenCommands` 抽成共享函数

`approval-rules.ts` 求值时展平命令树的 `visit` 递归提为 `flattenCommands(parsed): BashCommand[]`，`approval-suggest.ts` 的 `patternsFromCommands` 改用它，删掉第二份递归。

### D7 runtime 侧只留编排

`execute` 创建一次规则集（`createApprovalRuleSet` 的成本是一个闭包）并传给审批流程；`approveFullAccess` 与 `approveFullAccessUI` 只负责弹框、文案与决策分支；四个分支里的 `persistAllowRule(...)` 调用改为 `ruleSet.addAllowRules(...)`。`persistAllowRule` 改名为规则集的注入实现，函数体只剩写文件与刷新缓存。

## Risks / Trade-offs

- **注入三个协作方让构造点变长**：规则集不再是「自给自足」的 module。换取的是无环的依赖方向与可替换的建议逻辑；构造点只有 `runtime` 一处与测试里的 fake。
- **`isAllowed` 与 `evaluate` 的语义差异容易被误用**（`isAllowed` 只说 allow 覆盖，不考虑 deny 与重定向）：接口注释与 spec 的「只列出尚未允许的模式」场景固定这一分工，避免下一个人用它做放行判定。
- **`pendingPatterns` 依赖注入的 `suggestPatterns`**：若调用方注入与 UI 展示不一致的实现，子菜单会列出错误的模式。测试用真实 `commandPatternsFor` 覆盖主路径。
- **D5 是本次唯一有用户可见面的变化**（非法配置从静默追加换成明确报错）：proposal 已声明，且该路径仅在配置文件被中途改坏时可达。
