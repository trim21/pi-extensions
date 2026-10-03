# Proposal

## Why

`Bash` 是脚本里最常用的一件工具：搜文件名、跑构建、调外部 CLI 都靠它。但它的结果只有文本加一点截断记账（`details.truncation` / `fullOutputPath`，opencode 侧还有 `exitCode` / `timeout`），脚本想拿退出码或输出只能解析文本、甚至去读截断记账，既别扭又容易错——而「退出码」恰恰是脚本最需要的分支依据（`grep` / `rg` 无匹配退出 1 是正常结果，`git diff --quiet` 退出 1 表示有改动）。

同时，模型在两套工具集里都有专门的 `Grep` / `Glob`，它们的声明块（尤其 `Grep` 那十几个参数与三选一输出）占了 `codemode` 工具描述的一大截，而脚本要搜东西时用 `rg` 走 `Bash` 反而更顺手（能拿到退出码、能随手拼管道）。

## What Changes

```ts
{
  exitCode: number | null; // null = 命令被信号杀掉（超时/中止）或没有退出码
  output: string; // 命令的完整输出（stdout/stderr 已合并）
}
```

- **载荷只有退出码与输出**：没有 `ok`、没有 `status`——命令非零退出不是失败，脚本直接读 `exitCode` 分支；超时/中止时 `exitCode` 为 `null`，原因（超时还是用户中止）在模型侧文本与 `details` 里交代，脚本不需要区分。载荷外层仍是工具总线既有的 `structuredResult` 信封（它的 `ok: true` 只表示「工具给出了结果」，脚本看不到也不需要看）。
- **载荷给完整输出**：文本该截断还截断（那是给模型上下文的），载荷里给**完整**内容——截断时从落盘文件读回来（`BashOutput` 已经把全文流式写到 agent 临时目录）。脚本因此不需要知道 `fullOutputPath` 这类记账。
- **超时与中止**：`exitCode: null` + `output` 为已捕获的部分输出，同样是成功的结构化结果（脚本可以据此决定是否重试）。
- **文本与既有记账不变**：`isError`、文本输出、`details`（`truncation` / `fullOutputPath` / `exitCode` / `timeout`）与今天逐字/逐语义一致；截断与落盘仍是文本侧的事。
- **搜索工具不再进 `codemode`**：`Grep` / `Glob` 与 opencode 的 `grep` / `glob` 加入排除名单——脚本要搜就用 `call("Bash", { command })` 跑 `rg`（或 `grep`），走同一个沙箱、拿得到退出码与结构化输出。两个工具本身对模型照旧提供、行为不变，只是不再出现在 `codemode` 的描述里、也不能被脚本调用。
- **不拆分 stdout / stderr**：bwrap 执行层在捕获时已经把两个流合并（`src/bwrap/exec.ts` 的 `onData` 注释），给脚本「假装分开」是错的；要分开是执行层的另一件事，不在本次范围。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `claude-code-tools`：「Bash 沙箱执行」在文本输出不变的前提下给出结构化结果，并写明各字段与截断/落盘语义。
- `opencode-tools`：「bash 沙箱执行」同上（两个工具集的载荷形状一致）。
- `codemode`：「工具注册与可调用工具集合」的排除名单加入四个搜索工具，并说明脚本改用 `Bash` + `rg` 搜索。

## Impact

- 代码：`src/claude-code/shell.ts`、`src/opencode/bash.ts`（改用 `defineStructuredTool` 并构造载荷）、`src/codemode/tool.ts`（排除名单）。
- 测试：`test/claude-code-tools.test.ts`、`test/opencode-bash.test.ts` 补载荷断言（成功、非零退出、输出被截断时载荷仍是全文、超时、中止）；`test/codemode-tool.test.ts` 补「搜索工具不可调用 / 描述里不出现」，以及「脚本用 Bash 拿退出码」。
- 文档：README 与 AGENTS.md 里 codemode 的排除名单与「脚本搜索走 Bash」。
- 兼容性：`Bash` / `bash` 的文本、`details`、抛错语义都不变；对模型无感知。脚本侧新出现结构化返回值，`Grep` / `Glob` / `grep` / `glob` 从可调用集合移除属于本次的破坏性变化（脚本改用 `Bash`）。
- 关联：原先那份 `grep-glob-structured-results` 提案（给搜索工具加结构化载荷）随本方向作废——脚本不再调用搜索工具，载荷没有消费者。
