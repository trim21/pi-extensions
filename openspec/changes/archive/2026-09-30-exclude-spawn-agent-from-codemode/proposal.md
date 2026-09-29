# Proposal

## Why

`codemode` 把总线上除自己以外的全部工具写进工具描述，并允许脚本调用它们，`spawn-agent` 因此也在可调用集合里：脚本可以直接委派子代理任务。

`spawn-agent` 与 codemode 的成本模型不匹配。前者启动一个新的隔离会话（自己的上下文窗口、工具白名单与 UI 交互），单次运行以分钟计，进度只经 toolcall 进度回传；codemode 的定位是批量、编排普通工具调用。嵌套调用还会让一次 codemode 调用在脚本里不受限制地扇出多个子代理，成本与并发都不受模型直接调用时的节奏约束。

## What Changes

- codemode 的可调用工具集合排除 `spawn-agent`：它不再出现在工具描述的参数声明里，脚本调用它以「工具不可用」失败。
- 集合与当前 active 工具列表求交的既有规则不变；模型仍可直接调用 `spawn-agent`。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `codemode`：可调用工具集合从「总线上除 `codemode` 自身以外的工具」改为「总线上除 `codemode` 自身与 `spawn-agent` 以外的工具」，并补充对应场景。

## Impact

- 代码：`src/codemode/tool.ts`（`collectTools` 的排除集合）。
- 行为：脚本不再能调用子代理；`spawn-agent` 自身的能力与模型直调路径不受影响。
- 测试：`test/codemode-tool.test.ts` 补充描述与调用失败的断言。
