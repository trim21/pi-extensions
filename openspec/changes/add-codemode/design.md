# Design

## Context

动机见 proposal.md - Why。本变更建立在 `unify-tool-registration` 之上：工具注册已收敛到单一入口 `src/index.ts`，并提供工具总线（`register` / `list` / `get` / `executeTool`）。

其余影响设计的既有事实（均已在本仓库的依赖版本 0.87.1 上核对）：

- pi 0.87.1 的 `ExtensionContext` 没有 `executeTool`，也没有 `ctx.tools`；`registerTool` 的 `ToolDefinition` 没有 `exposure` / `prepareLoadout`；`pi.getAllTools()` 返回的 `ToolInfo` 不含 `execute`。这些是 pi 0.99 引入的，本实现不需要。
- 本仓库工具的审批写在**工具实现内部**而不是钩子：`guardWriteAccess` 由 `Read` / `Edit` / `Write` / `lsp-rename` 的 `execute` 直接调用（`src/claude-code/files.ts:373/439/537`、`src/lib/lsp/rename-tool.ts:201`），Bash 的提权审批在 `BwrapRuntime.execute` 内部——经总线执行工具仍然保留这些审批。
- 0.87.1 已有 `pi.appendEntry(customType, data)`（session custom entry）与 `ToolDefinition.constrainedSampling`（grammar 约束采样）。
- `src/bwrap/` 的现成部件：`buildBwrapArgs`（按 fs / network 两轴产出参数）、`findBwrap`；而 `buildBwrapInvocation` 固定追加 `shell -lc` 与一套干净环境，`BwrapRuntime.execute` 只返回一次性捕获的输出。
- `@earendil-works/pi-codemode` 与 pi 没有依赖关系（只依赖 `quickjs-wasi`），可以在 0.87.1 上使用。

## Goals / Non-Goals

**Goals:**

- 不依赖 pi 新 API：嵌套调用经我们自己的工具总线执行。
- 脚本进程与 pi 之间除 stdio 协议外没有共享能力：读不到工作区与 agent 敏感数据，没有网络。
- 脚本里每次只读集合之外的调用对用户可见、可逐次拒绝；工具自身的审批继续生效。
- 脚本结束（正常 / 失败 / 超时 / 中止）后不残留进程。
- 脚本接口与 pi codemode 一致，模型侧无需学习两套写法。

**Non-Goals:**

- 不触发其他扩展注册的 `tool_call` / `tool_result` 钩子；不覆盖 pi 内置工具与第三方扩展的工具（它们不在我们的总线上）。
- 不做 `models.classify()`、`codemode.mode: "only"`、`tool_search` 协作。
- 不做常驻沙箱进程复用，不做嵌套调用可视化面板。
- 不改 bwrap 既有 spec 描述的 bash 沙箱行为。

## Decisions

**1. 嵌套调用经我们自己的工具总线执行，不用 pi 的 `ctx.executeTool`。**

codemode 持有统一入口创建的总线，每个嵌套调用走 `bus.executeTool(name, args, { ctx, signal, toolCallId, onUpdate })`：参数校验、错误归一化都由总线负责，工具实现内部审批照常生效。

- 备选：等 pi 升级后用 `ctx.executeTool` → 否决。会把「能否用 codemode」绑在 pi 版本上，而 0.87.1 上完全可行。
- 备选：直接拿工具定义调 `execute` → 被 `unify-tool-registration` 的总线取代（校验、错误归一化、按名查询都要各写一遍）。
- 知道代价：不经过 pi 的扩展钩子。本仓库审批在工具实现内部，不受影响；受影响的是其他扩展注册的钩子，写进文档与 Risks。

**2. codemode 注册在统一入口 `src/index.ts` 内。**

入口创建总线时把 `codemode` 的注册放在各模块注册之后，因此描述能反映本次实际注册的工具集合；同一入口也保证了 codemode 与工具共享同一份模块状态（read-state、bwrap runtime、LSP 服务）。

**3. 可调用集合 = 总线上实际注册的工具 − `codemode` 自身，执行时再与当前 active 工具列表求交。**

描述在注册时由 `bus.list()` 渲染（`name` / `description` / `parameters` → TypeScript 声明）。排除 `codemode` 自身是硬要求（防递归）。调用时额外用 `pi.getActiveTools()` 过滤，这样 pi 自己的 `defaultTools` / CLI `--tools` / 子代理工具白名单的排除同样生效——总线只知道注册结果，不知道会话层面的启用状态。`AskUserQuestion`、`TodoWrite` 等交互/会话类工具保留可调用，要关掉就用 `personalExtensions.disabledTools`。

- 备选：只信总线、不看 active 列表 → 否决：脚本能调到模型白名单之外的写类工具，等于绕过会话的工具限制。
- 备选：像内置 codemode 那样区分 `direct` / `deferred` exposure → 0.87.1 没有 exposure 概念，且我们的工具集规模不需要分级。

**4. 只读集合按文件 IO 工具集的命名匹配：`Read` / `Glob` / `Grep` 或 `read` / `glob` / `grep`；其余调用逐次确认。**

经总线执行意味着脚本里的写操作可能完全不弹框（工作区内写入、沙箱内执行都不需要用户确认），这正是本变更要补的可见性。确认复用 `src/lib/ui.ts` 的 `selectWithOptionalInput`（Approve once / Block / Block with reason），与 `guardWriteAccess` 的交互风格一致；工具自身的审批叠加在其上，两层都成立。

- 备选：全部确认 → 否决，读密集脚本不可用。
- 备选：按 `annotations.readOnlyHint` 判定 → 0.87.1 的工具没有注解；见 Open Questions。

**5. 沙箱配置固定为「根只读 + 无网络 + 遮蔽敏感路径」，独立于用户的 `/bwrap-*` 配置。**

脚本进程不需要任何宿主能力；用用户当前模式会让 `workspace-write` 把工作区写权限交给脚本进程，也会让行为随会话中切模式而变。做法：沿用 `--ro-bind / /` + `--dev` / `--proc` 的形状，用 `--tmpfs` 遮蔽 workspace 与 agent 目录下的敏感路径（`auth.json`、`mcp-auth.json`、`sessions/`、`tmp/` 等），随后按需只读回挂运行所需的最小路径（扩展目录、`@earendil-works/pi-codemode` 与 wasm、node 可执行文件）——bwrap 的挂载按顺序后者覆盖前者，这正好表达"先在根上遮蔽、再开洞"。

- 备选：复用 `BwrapRuntime.execute` → 否决，它只捕获输出、命令结束才返回，无法在脚本运行中回送工具结果。
- 备选：最小 root（只 bind node 与依赖）→ 暂不采用，nix / mise / homebrew 下 node 布局差异大，先遮蔽再回挂更稳。

**6. 父子之间用 stdio 上的 NDJSON 协议，自己组装 bwrap argv。**

只复用 `buildBwrapArgs` + `findBwrap`，自己 `spawn` 出 `bwrap … -- node <helper.js>`，子进程 stdout 出站、stdin 入站。

- 备选：走 `buildBwrapInvocation` → 否决，它固定追加 `shell -lc` 与干净环境，承载不了双向协议。
- 备选：FIFO 或文件轮询 → 否决，两侧都要管生命周期，终止路径容易死锁。

**7. 每条 codemode 调用起一个一次性沙箱子进程。**

生命周期最简单，天然满足「无残留进程」；与内置沙箱「每次执行新的 VM」的语义一致。

- 备选：常驻沙箱进程 → v1 否决。要多处理闲置回收、会话切换、崩溃重启，而收益只是几十毫秒的启动时间。

**8. 沙箱运行时用 `@earendil-works/pi-codemode`，不自己写 QuickJS 宿主。**

它已处理中断（SharedArrayBuffer 标志 + `worker.terminate`）、内存上限、深递归的 `RangeError`、以及"等一个永远不会 settle 的 promise"的检测；它对 pi 没有依赖，直接可用。

**9. helper 用 esbuild 预构建为单文件并提交（沿用 `src/bwrap/holder.js` 的先例）。**

沙箱内不适合依赖 tsx / jiti 这类运行时加载器；依赖包保持 external，否则 `@earendil-works/pi-codemode` 运行期解析不到自己的 worker 文件。

**10. `store` / `load` 落 session custom entry（类型 `codemode-store`），用 0.87.1 已有的 `pi.appendEntry`。**

分支与恢复语义交给 pi 的 session 机制，扩展不自己维护跨调用状态。

**11. 描述在注册时静态生成，不做 loadout 改写。**

`prepareLoadout` 不存在；而可调用集合在注册完成时就已确定，注册时渲染一次即可。注册发生在每个会话启动（见 `unify-tool-registration` 决策 6），因此描述天然跟随该会话的工具面。在 0.99+ 上注册同名工具会替换内置 codemode，这是 pi 的行为，不需要我们调用它的任何新 API。

## Risks / Trade-offs

- [其他扩展的 `tool_call` / `tool_result` 钩子不触发] → 本仓库的审批在工具实现内部（`guardWriteAccess`、Bash 提权），不受影响；受影响的是第三方扩展的策略钩子，写进 README 与工具描述。
- [总线上没有的工具就是不可调用] → 与 `unify-tool-registration` 的注册故障隔离一致：某模块注册失败时它的工具也不在脚本可调用集合里，行为可预期。
- [0.99+ 上替换内置后失去 `models.classify`、`codemode.mode: "only"`、`tool_search` 协作] → 已知取舍，写进文档；禁用本扩展即回到内置行为。
- [每次调用多出 node 启动 + wasm 编译 + bwrap 建立的开销] → 量级为数十毫秒，一次 codemode 调用通常编排多次工具调用；若实测明显，再单独提案做常驻进程。
- [bwrap 不可用（macOS / Windows / 无权限）] → 降级为普通子进程并在结果里标注未隔离，spec 已要求。
- [遮蔽 agent 目录后 helper、wasm 或 node 落在被遮蔽路径下] → 按需只读回挂最小路径，测试覆盖这条路径。
- [子进程输出量大导致 stdio 背压] → 父进程持续读取并流式转发，不在内存里攒全量；截断与落盘沿用 bwrap runtime 的既有做法。
- [终止进程树不可靠] → bwrap / unshare 对 SIGTERM 有坑（`src/bwrap/README.md` 设计约束第 5 条），终止时向进程组发 SIGKILL 并等待收敛，用死循环脚本断言无残留。
- [无 UI 会话里只读集合之外的调用被拒] → 脚本可能部分失败后继续，属预期行为；spec 要求拒绝以错误形式回到脚本。

## Migration Plan

- 前置：`unify-tool-registration` 先落地（单一入口 + 工具总线 + `personalExtensions` 配置）。
- 新增运行期依赖 `@earendil-works/pi-codemode`；helper 的构建脚本加入 `package.json`（模式同 `build:holder`），产物随仓库提交。
- peerDependencies 不变，无数据迁移。
- 回滚：把 `codemode` 的注册从 `src/index.ts` 移除即可。

## Open Questions

- 是否给本仓库工具补 `annotations.readOnlyHint`（pi 0.99 有该字段），把只读判定从常量集合换成注解驱动？跨越多个模块，可单独提案。
- 在 0.99+ 上是否改为优先用 `ctx.executeTool`（走完整钩子）、拿不到时回退总线执行？两条路径的可达工具集合不同，v1 不做。
- 脚本调用 `AskUserQuestion` 是否会让交互层次混乱？当前允许，实测后若确实混乱再排除。
