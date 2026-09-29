# Proposal

## Why

本仓库现在有 11 个扩展入口，工具注册散在 8 个模块里（aft、gh-readonly、talk、web × 2、spawn-agent、vision-agent、claude-code / opencode）。这带来三个具体问题：

- 「启用哪些工具」只能靠 pi settings 里 `packages[].extensions` 的排除项表达，粒度是**入口文件**而不是工具：想关掉一个工具就得排除它所在的整个文件。
- 两套文件 IO 工具集（claude-code / opencode）的二选一也只能靠 `!src/opencode/index.ts` 这类写法表达，而不是一个明确的开关。
- pi 给每个扩展入口**独立的模块图**（模块级状态不跨入口共享），所以任何"看到本仓库全部工具"的能力在入口隔离下都做不到——这正是 codemode 想直接调用我们的工具时遇到的第一道墙。

## What Changes

- 新增单一扩展入口 `src/index.ts`：按配置依次注册本仓库各模块的工具。`pi.extensions` 中注册工具的分入口被它取代；`session-name` 与 `system-prompt` 与工具注册无关，保持各自的入口与行为不变（不在本变更范围内）。
- 新增 `~/.pi/agent/settings.json` 的 `personalExtensions` section：
  - `fileIo`: `"claude-code" | "opencode"`（默认 `"claude-code"`）——决定注册哪一套文件 IO 工具集。
  - `disabledTools`: 工具名数组——列出的工具不注册。
- 各工具模块不再直接调用 `pi.registerTool`，改为注册进我们自己实现的 **tool bus**：总线按配置过滤、统一交给 pi 注册、保存通过的工具定义，并对外提供 `executeTool(name, args)`（参数校验 + 执行 + 错误归一化），供同入口内的模块（codemode）直接调用工具，不经过 pi 的转发。
- 工具模块保留可独立按路径加载的形态（`export default function xxx(pi)`），spawn-agent 的子代理仍用它们按声明加载最小工具集；`disabledTools` 同样作用于子代理的工具清单。
- 单个模块注册失败不影响其他模块：错误被捕获并以警告上报，不静默吞掉。
- 配置里出现非法值或未知工具名时给出可诊断的警告。

## Capabilities

### New Capabilities

- `tool-registration`: 本仓库工具的注册入口与启用配置。

### Modified Capabilities

无。

## Impact

- 代码：新增 `src/index.ts` 与配置读取/注册层模块；改造 8 个工具模块的注册调用；`src/spawn-agent.ts` 的工具清单按配置过滤；`package.json` 的 `pi.extensions` 收敛。
- 用户可见的破坏性变化：`packages[].extensions` 里的入口级排除（例如 `!src/opencode/index.ts`、`!src/web/search.ts`）在升级后不再生效——那些文件不再是扩展入口。等价能力改用 `personalExtensions.fileIo` 与 `personalExtensions.disabledTools` 表达，升级说明里给出对照表。
- 风险：单一入口把"模块注册失败"的影响面从"少一个入口"扩大到"少一个入口的全部工具"，因此逐模块隔离失败是必须的；所有模块的注册代码会在 session 启动时执行一次，其中的重依赖（aft bridge、talk 的 SQLite、LSP 服务）必须保持惰性初始化，不在注册阶段建连接。
- 测试：`test/tool-registration.test.ts`（配置解析与警告、禁用过滤、文件 IO 二选一、模块失败隔离），以及入口级集成测试（`pi.extensions` 加载后工具清单符合配置）。
