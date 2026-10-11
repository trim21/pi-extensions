# Proposal

## Why

codemode 脚本目前没有任何执行时长约束：spec 明确写着"脚本没有整体超时"，唯一的结束方式是调用方中止。两类脚本因此会长时间占住调用（codemode 是 `executionMode: "sequential"` 的工具，会把整批工具调用一起占住）：LLM 写出的忙循环（`while (true) {}`）只能等用户按 Esc；`await sleep(3600)` 这样的无界等待同样如此。

同时，脚本内调用的工具会照常弹审批框——"人花在弹窗上的时间"是不可预测的等待，这让任何按墙钟计算的执行预算都无法成立。pi 内置 codemode 的 `timeout_ms` 之所以可行，是因为它把等待工具的时间也算进预算；我们要引入同名的机制，就得先消掉这个不可预测项。

脚本选项**继续留在脚本首行的 `// @options` 行里**，不改成工具参数：pi 会把声明了 grammar 约束的工具转成 OpenAI 的"单自由文本"custom tool（`packages/ai/src/api/openai-responses-shared.ts:367-379`），JSON schema 整体不参与请求——多出来的参数要么在构建期直接报错（required 属性多于一个），要么被静默忽略（optional）。pi 内置 codemode 正是"单个 `code` 参数 + 注释选项 + grammar"的形态，这里跟随它。

## What Changes

- 脚本首行的 `// @options` 增加 `timeout_ms`（正整数，上限 2147483647，未设置时**无超时**）。
- 超时到点时先定结果再收尾：返回 `kind: "timeout"` 的失败（带上已产生的输出与完整调用记录），中止正在执行的嵌套工具调用，最后终止 worker。
- codemode 内的嵌套调用**不再弹审批**：需要人工授权的操作（写工作区外、Bash 沙箱外执行、web 的非沙盒请求，以及脚本 `fs.write` 的同类情况）在 codemode 内一律直接失败，错误信息说明"需要授权，请直接调用该工具"。
- 保留"等一个永远不会 settle 的 promise 立刻失败"（`stalled`）；只把它的错误文案改准——现在有了 `sleep`，文案里"timers do not exist here"已经自相矛盾。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `codemode`: 「脚本接口」的 `// @options` 增加 `timeout_ms` 字段；「嵌套调用的执行」由"审批照常生效"改为"需要授权的调用直接失败"；「中止」去掉"没有整体超时"的绝对表述；新增「执行超时」描述预算语义与到点收尾。

## Impact

- 代码：`src/codemode/source.ts`（解析 `timeout_ms`）、`src/codemode/sandbox.ts`（宿主超时定时器、超时收尾、合成中止信号）、`src/codemode/tool.ts`（把预算传给沙箱、把"不可审批"传给嵌套调用）、`src/codemode/protocol.ts`（`timeout` 错误类型）、`src/codemode/prelude.ts`（`stalled` 文案）、`src/lib/tool-bus.ts`（`execute` 的可选调用选项）、`src/lib/write-guard.ts` 与 `src/bwrap/runtime.ts` 的拦截（含两套 Bash 工具透传）。
- 不新增配置字段：`timeout_ms` 由脚本自己在首行声明，审批策略由 codemode 路径固定。
- 测试：`test/codemode.test.ts`、`test/codemode-tool.test.ts` 与 write-guard / bwrap 相关用例。
