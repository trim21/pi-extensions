# Design

## Context

`Bash`（claude-code）与 `bash`（opencode）共用 bwrap 执行层，结果形状由各自工具决定：

|                    | 成功                                                                            | 非零退出                                                                                             | 超时                                                 | 中止                                      |
| ------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------- |
| claude-code `Bash` | 文本=截断后输出 + 截断提示；`details: { truncation, fullOutputPath }`           | 文本=**完整**输出（从落盘文件读回）+ 退出码状态行；`details: undefined`                              | 文本=部分输出 + 超时行；`details: undefined`         | 同上（aborted 行）                        |
| opencode `bash`    | 文本=截断后输出 + 截断提示；`details: { exitCode, truncated, fullOutputPath? }` | 文本=截断后输出 + `Command exited with code N.`；`details: { exitCode, truncated, fullOutputPath? }` | 文本=部分输出 + 超时行；`details: { timeout: true }` | 文本=部分输出 + aborted 行；`details: {}` |

两者执行层返回的都是 `{ exitCode, output, fullOutputPath?, truncation, sandboxHint, sandboxReminder? }`，其中 `output` 是**已经合并 stdout/stderr** 且可能被尾部截断的文本，完整输出在运行时就被流式写到 `agent-dir/tmp/{sessionId}/{uuid}.txt`（`BashOutput`，内存只保留尾部）。超时/中止走 `BashInterruptedError` 的 `partial` 快照。

## Decisions

### D1：载荷给完整输出，文本该截断还截断

文本的截断是给模型上下文用的（尾部截断 + 截断提示，完整内容流式落到 agent 临时目录）；脚本不是模型，它要的是命令到底输出了什么。所以载荷的 `output` 是**完整**输出：文本没截断时就是同一份，截断时从落盘文件读回全文。

代价是「流式落盘、内存只留尾部」这套设计在载荷这一侧被绕过了：一次输出很大的命令会把全文读回宿主内存、再经 JSON 过桥进 VM。这是明确接受的代价——脚本本来就要把内容拿在手里处理，而截断后的残缺输出会让脚本静默做错事（这比多花内存更糟）。工具侧不再需要 `truncated` / `fullOutputPath` 这类记账字段：载荷里就是全文。

### D2：退出码就是退出码，载荷里没有成败标志

`rg` 没匹配退出 1、`git diff --quiet` 退出 1 都是脚本要据以分支的**正常结果**。载荷因此只有 `status` / `exitCode` / `output` 三个字段：脚本读 `exitCode` 分支，不需要先看 `ok`、也不必 `try/catch` 去分辨「命令返回非零」和「工具真的出错」。

- 命令跑完（无论退出码）→ `exitCode` 给出真实退出码。
- 超时 / 中止 → `exitCode: null`，`output` 是已捕获的部分输出（脚本据此决定是否重试）；两者的区别在模型侧文本与 `details` 里，脚本不需要区分。
- 工具自身出错（比如沙箱起不来）仍然抛错，由总线转成 `ok: false`——「没跑成」才是失败，「跑成了、退出码非零」不是。

这与两个工具今天的语义一致（非零退出、超时、中止都是 return 而不是抛错），`isError` 也不改。载荷本身因此只有 `exitCode` 与 `output` 两个字段，没有 `status` 也没有成败标志。载荷外层仍是工具总线既有的 `structuredResult` 信封（`ok: true` = 工具给出了结果），那层是宿主与脚本之间的传输细节，脚本拿到的是解包后的载荷，不需要看它。

### D3：`exitCode` 用 `null` 表示「没有退出码」

被信号杀死（超时、中止）时进程没有退出码，用 `null` 而不是 0 或 -1，避免脚本把「被杀」当成成功。不再另设 `status`：脚本对「超时」与「用户中止」的处理没有区别（都是没跑完），需要区分的是模型，而文本与 `details` 已经说明了原因。opencode 侧今天的 `details.exitCode` 也是 `number | null` ✓ 语义一致。

### D4：不拆 stdout / stderr

执行层捕获时就把两个流合并（`src/bwrap/exec.ts`：`child.stdout.on("data", onData)` 与 `child.stderr.on("data", onData)` 同一个回调），文本输出也一直是合并的。要在载荷里分开就得改执行层的捕获与落盘（两个 sink、两个文件或带标记的单文件），顺带影响 `truncation` 与 `fullOutputPath` 的语义——那是执行层的独立变更，本次不做。载荷里说明「已合并」，脚本要分开可以自己重定向（`cmd 2>/tmp/err`），因为它是普通 shell。

### D5：两个工具集的字段名一致，文本各自保留

载荷字段完全一致（`status` / `exitCode` / `output` / `truncated` / `fullOutputPath`），这样脚本换工具集不用改代码，codemode 的返回类型渲染也一致。文本差异（claude-code 失败时给完整输出、opencode 给截断输出 + 状态行）是两套工具集刻意保留的风格差异（AGENTS.md 明确不统一），本次不动——`output` 各自与自己的文本一致。

### D6：搜索工具从 codemode 的可调用集合里去掉

`Grep` / `Glob` / `grep` / `glob` 加进 `EXCLUDED_TOOL_NAMES`。收益有两条：

1. 脚本搜文件用 `call("Bash", { command: "rg …" })` 更顺手——退出码可用、能拼管道、能顺手做后续处理（`rg -l | xargs …`），而搜索工具是给模型看结果的（相对路径、分组渲染、分页尾巴），脚本拿到这些还得再解析。
2. codemode 的工具描述里因此少掉两个大声明块（`Grep` 的参数表加三选一返回类型，含上下文行/行号/分页等一整串），描述体积与 token 成本直接下降。

搜索工具本身对模型照旧（不受影响），只是不再出现在 `codemode` 的描述里。

## Risks / Trade-offs

- **大输出的内存代价**（D1）：`rg -n . /big/tree` 这类命令的输出全文会被读回宿主再进 VM，可能几十上百 MB。可接受的缓解是脚本自己收窄命令（`| tail`、`| head`、`-m`）。
- **脚本拿不到 stderr 单独内容**（D4）：与模型在同一条船上，重定向可解（`cmd 2>/tmp/err`）。
- **过桥是一次 JSON 往返**：全文进脚本是字符串拷贝 + 解析，超大输出会有可观的开销；这是 D1 的另一面，不做额外优化（真要极致的流式处理，脚本用 Bash 自己 `grep` 并只把需要的部分输出回来）。
