# codemode 的可调用集合改为「有结构化输出才进」

## Why

`codemode` 今天用一份手工黑名单决定脚本能调什么（`EXCLUDED_TOOL_NAMES`：`codemode` 自身、`spawn-agent`、文件读写工具、搜索工具）。这份名单有三个问题：

1. **它会漂移。** 每加一个工具都要重新判断要不要排除，忘记加就是默认放行；上一轮加 `Bash` / `gh` 的结构化输出时，我们已经在名单上打过两次补丁。
2. **判断依据与实现不一致。** 脚本里 `call()` 的返回值必须有确定的形状，而「工具该不该给脚本用」这件事，只有工具自己知道；黑名单在 `codemode` 侧重复了这份知识。
3. **黑名单里的工具大多本来就进不来。** 文件读写工具、搜索工具、talk 会话工具都没有结构化输出，脚本拿到只能是文本。

趁这次给 gh / LSP 工具补结构化输出，把准入条件改成**工具声明了 `structuredSchema` 才进集合**：一条规则，自己维持一致。

## What Changes

- **准入条件**：`codemode` 的可调用集合 = 总线上声明了 `structuredSchema` 的工具 ∩ 当前 active 工具列表。`EXCLUDED_TOOL_NAMES` 整个删掉。
- **声明渲染**：集合里每个工具都有返回类型（不再有「未声明就渲染成 `Promise<string>`」这条分支）；`ToolLike.structuredSchema` 从可选变必需。
- **天然不在集合里**（各自的理由都独立成立，不再需要名单）：`codemode` 自身与 `spawn-agent`（没有 schema）、文件读写工具（脚本用 `fs.read` / `fs.write`）、搜索工具（脚本用 `call("Bash", …)` 跑 `rg`）、`lsp-rename`（写工具）、talk 工具与会话工具（会把执行时间交给用户或另一个 agent 的回答）。
- **文案**：`codemode` 的工具描述与头部注释、README、AGENTS.md 说明改为「有结构化输出才可调用」。

## Impact

- `src/codemode/tool.ts`（`collectTools`、`CallableTool`、头部注释）、`src/codemode/declarations.ts`（`ToolLike`、`renderOverload`）。
- `test/codemode-tool.test.ts`：桩工具改成声明 schema；新增「没 schema 的工具既不列出也不可调用」「声明了 schema 却没给载荷时脚本拿到 `CallFailedError`」。
- 行为变化（预期）：`Grep` / `Glob` / `grep` / `glob`、`Read` / `Edit` / `Write` / `read` / `edit` / `write`、`spawn-agent`、talk 与会话工具从描述里消失；`Bash` / `bash`、4 个 AFT 工具、10 个 gh 工具仍在。
- 依赖顺序：本条 delta 与 `bash-structured-results`（#176，已归档）改的是同一条 requirement，且它把后者的黑名单整段替换掉——归档顺序必须是先 #176（已完成）再本条。

## Out of Scope

- 给还没有结构化输出的工具补 schema（gh 文本类、LSP 三个工具是本轮接下来的工作，各自单独提 change）。
- 是否给 `spawn-agent` / talk / 会话工具加结构化输出。按新规则，加了 schema 就会进集合；要不要加是它们自己的产品判断，不在本条。
