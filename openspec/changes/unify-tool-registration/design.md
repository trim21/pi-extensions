# Design

## Context

动机见 proposal.md - Why。影响设计的既有事实（均已核对）：

- `package.json` 的 `pi.extensions` 有 11 个入口；注册工具的模块有 8 个（`aft`、`gh`、`talk`、`web/search`、`web/fetch`、`spawn-agent`、`vision-agent`、`claude-code` / `opencode`）。这 8 个模块都已导出 `export default function xxx(pi: ExtensionAPI)`，即 pi 的扩展入口签名。
- pi 的扩展加载器给每个入口单独的模块图，模块级状态不跨入口共享。
- `spawn-agent` 用 `additionalExtensionPaths: overrideExtensionPaths(tools)` 给子代理按工具名加载模块文件（`TOOL_EXTENSION_OVERRIDES` 把工具名映射到模块文件路径），并用 `createAgentSession({ tools })` 的 allowlist 限制可见工具；bash 类工具另用内联工厂（`subagentShellExtension`）——路径加载没有参数通道，所以 per-agent 配置只能走内联工厂。
- 读配置的既有做法是扩展自己读 `~/.pi/agent/settings.json` 并解析自己的 section（`talk` 在 `src/talk/index.ts:87`、`sessionName` 在 `src/session-name.ts`）；解析要求用 typebox（仓库规范）。
- 上报配置问题的既有做法是 `onWarning` 回调（`src/lib/lsp/lsp.ts:239`），在拿到 UI 的时机（`session_start`）呈现。
- `@earendil-works/pi-agent-core` 的 harness 已有一套工具执行链（`prepareToolCall` / `applyBeforeToolDecision` / `executeToolCall` / `finalizeToolCall`），但它绑定 harness 自己的 gate 与 `Context`，不是给扩展直接用的入口。
- 通配匹配有现成依赖与先例：`minimatch` 是直接依赖，`matchesInclude`（`src/lib/lsp/server-config.ts:290`）已在用它。
- 加载期拿不到当前模型：`ExtensionAPI` 只有 `setModel`，没有 `getModel`；模型出现在事件上下文的 `ctx.model`。pi 的内置 MCP 扩展是启动后才注册工具（连上服务器才可用），说明加载后 `registerTool` 受支持。

## Goals / Non-Goals

**Goals:**

- 用一份配置决定「注册哪一套文件 IO 工具集」和「哪些工具可用」，替代入口级排除。
- 工具名与模型名都用通配匹配；规则可限定模型（例如 glm 用 opencode 那套工具名、gpt 用 claude-code 那套）。
- 工具注册集中到单一入口，并提供统一的总线（注册 / 枚举 / 按名执行 `executeTool`）供同入口模块直接调用工具。
- 子代理的最小工具集与既有加载机制不受影响。
- 一个模块注册失败不拖垮其余工具。

**Non-Goals:**

- 不改变任何工具自身的行为、名字或输出。
- 不把 `session-name` / `system-prompt` 等其他扩展纳入本变更：它们与工具注册无关，保持各自的入口与行为不变。
- 不做项目级配置合并（见 Open Questions）。
- 不在会话中途跟随 `/model` 切换工具面（见决策 6）。
- 不引入跨模块的全局可变状态（仓库规范要求工厂 + 闭包）。

## Decisions

**1. 单一入口 `src/index.ts`；模块暴露 `createXxx(pi)`，默认导出保留给按路径 `-e` 加载。**

入口调用各模块的 `createXxx(pi)` 取注册函数，因此一个实例里每个模块只有一份状态（reads 记账、LSP 服务、bridge 池都不会翻倍）。默认导出仍保留：手工 `-e` 加载与既有测试用它。

- 备选：把模块合并成一个大文件 → 否决，模块边界消失、单文件过大。
- 备选：入口只调默认导出 → 否决，那样拿不到模块内部的共享对象（共享服务、工具单元）。

**2. 注册层实现为工具总线 `src/lib/tool-bus.ts`，由工厂创建、状态由闭包持有。**

总线 API：`register(def)`（按配置过滤 → `pi.registerTool(def)` → 保留定义）、`list()`、`declaredNames()`、`get(name)`、`executeTool(name, args, opts)`。`executeTool` 用工具自身的 typebox schema（先过 `prepareArguments`）校验参数，再调用 `def.execute(toolCallId, args, signal, onUpdate, ctx)`，并把校验失败与抛出的异常归一化成 `{ content, isError: true }` 结果——codemode 需要的是"错误回到脚本"，不是异常穿透到调用方。

配套 `src/lib/tool-registration.ts` 的 `createToolRegistration(pi)`：读配置、建总线、注册「记录本会话模型」的 `session_start` handler，暴露 `onSessionStart(register)` 与 `unmatchedPatterns()`；`registerToolsOnSessionStart(pi, register)` 是独立入口的简写。顺序很关键：模型 handler 必须先于所有注册 handler。

- 备选：复用 `@earendil-works/pi-agent-core` 的 harness 执行链（`prepareToolCall` / `executeToolCall` / `finalizeToolCall`）→ 否决。它们绑定 harness 的 gate、`Context` 与 hook 管线，要先构造一整组宿主对象；我们需要的只是"校验 + 执行 + 归一化错误"。
- 备选：让消费者各持工具定义互相直调 → 否决。每个消费者都要重复处理校验与错误，也拿不到统一的过滤视图。

**3. 模块的注册函数只收发工具的总线（+ 需要时显式传 pi）。**

`registerFileTools(bus, state, getService, policy)`、`registerGrepTool(bus, pi)`、`registerShellTools(bus, pi, runtime)`；扩展入口/默认导出负责把「当前会话模型 → 总线」接上并在 `session_start` 里调用它们。

- 过滤发生在总线里，所以「经入口注册」与「按路径注册」行为一致，`disabledTools` 自动同时作用于两者，不需要给路径加载加参数通道。
- 备选：把过滤放在入口层 → 那按路径加载的入口会绕过过滤，与 spec 冲突。

**4. 共享服务由入口持有，注入给选中的工具集。**

`src/lib/tool-services.ts` 的 `createToolServices(pi, options?)` 建一份请求策略、bwrap runtime（并 `setup(pi)` 注册 `/bwrap*` 命令与沙箱系统提示）与 LSP manager，注入给选中的文件工具集；LSP 专属工具经 `setLspEnabledHandler` 交给「本会话选中的那套」注册。理由：两套文件工具集各自建一份会重复注册 `/bwrap*` / `/lsp-*` 命令（命令名冲突成 `/bwrap:1`）。

- 固定沙箱（子代理）走 `options.sandbox`，此时 runtime 不注册命令（既有语义）。

**5. 工具单元表 `src/lib/tool-units.ts` 描述「工具名 → 提供者」，主入口与子代理共用。**

`TOOL_UNITS[fileIo]` 是一组 `{ tools, register(deps) }`。主入口按 `fileIoByModel` 选中一套后注册该套的全部单元；`subagentToolsExtension(agent, tools)` 在**一个 inline 扩展工厂**里建一份 registration + services，只为 frontmatter 声明的工具名注册覆盖到的单元，沙箱配置经闭包传给 bwrap runtime。

这**取代了原来的 `-e` 路径加载**（`overrideExtensionPaths` / `subagentShellExtension` 已删除）：路径加载是「一个模块一份模块图」，子代理里没有任何东西能看到完整工具集，也没有 per-agent 配置注入通道——两个问题都在 inline 工厂里消失。

**6. 判定时机：每个 `session_start` 用 `ctx.model` 判定并注册。**

加载期 `ExtensionAPI` 读不到当前模型（只有 `setModel`，没有 `getModel`），模型只在事件上下文的 `ctx.model` 里。而 pi 在启动 / 会话替换 / `/reload` 时重建 ResourceLoader 并重新加载扩展（`AgentSessionRuntime.createRuntime` → `createAgentSessionServices` → `new DefaultResourceLoader(...)` + `await reload()`，见 `src/main.ts:724/856`、`src/core/agent-session-runtime.ts:226`），所以每次会话启动都是新扩展实例、新 `pi` 与 `ctx`。

于是注册就放在 `session_start` 里：按该会话的模型算出生效工具集与禁用集合再注册，工具面随会话走，不需要"只注册一次"的守卫（同名重复注册在 pi 侧是对该扩展工具表的覆盖写入 + 立即刷新）。

- 同一会话内 `/model` 切换不重建扩展，因此不重新判定。写进文档：换模型请开新会话。
- 备选：两套工具集都注册、按模型切 pi 的 active 列表 → 否决（用户已定案）。代价是未选中的那套也在进程里（违反"不注册"），且两套都要建 bwrap runtime 与 LSP 服务。

**7. 逐模块隔离失败。**

入口对每个单元与模块的注册做 try/catch：捕获名字与错误，继续注册其余部分，失败进同一份警告列表，在 `session_start` 里用 `ctx.ui.notify` 一次性上报。理由：入口收敛后，"一个模块炸掉"不该等于"所有工具消失"。

**8. 注册只登记定义，不建资源。**

各模块既有的资源时机保持不变（talk 在扩展加载期开 SQLite、aft 在会话启动期建 bridge 池、LSP 服务在会话启动期按配置创建），但注册本身不额外触发执行路径上的资源创建：`bus.register` 只登记定义，`executeTool` 只在被调用时才执行工具。

**8a. 工具可见性只由「注册与否」决定，不碰 pi 的 active 列表。**

`pi.registerTool` 后工具默认进入 active 列表（pi 的 `defaultActive` 语义），所以禁用工具 = 不注册，选工具集 = 只注册选中那套。扩展不调用 `pi.setActiveTools` 去补/去改状态（本仓库只有 vision-agent 因「主模型是否支持视觉」这一个既有场景在用）。

已知限制（写进 README）：pi 的工具表里存在同名内置项（`read` / `edit` / `write` / `bash` / `grep` / `find` / `ls`），同名时该名字的启用状态由内置项决定。`defaultTools: []` 下在 `session_start` 注册的同名扩展工具（opencode 那套的 `read` 等）不会被激活，于是不进入模型可见的工具清单；`--tools read,grep` 显式列出即可见。Claude Code 风格命名（大写）没有重名，不受影响。

**9. `disabledTools` 同时作用于子代理。**

子代理有自己的 `session_start` 与模型，inline 工厂里建的那份 registration 用同一份配置求值，因此被禁用的工具在子代理里同样不注册；spawn-agent 也不把这些工具名放进 `createAgentSession({ tools })` 的白名单。

**10. 迁移用文档 + 对照表，不做兼容层。**

`packages[].extensions` 里的 `!src/opencode/index.ts`、`!src/web/search.ts` 这类入口级排除在升级后不再指向任何入口（那些文件不再是 `pi.extensions` 的条目），从扩展内部无法检测，因此不做运行时提示，只在 README 与 AGENTS.md 给对照表。

## Risks / Trade-offs

- [入口收敛放大单点故障] → 决策 7 的逐模块 try/catch + 警告上报。
- [启动时执行所有模块的注册代码] → 注册只登记定义（决策 8），资源时机保持各模块既有行为；`tools-config` / `tool-bus` / 单元表的单测覆盖求值路径。
- [用户升级后旧排除项静默失效] → 文档对照表；换用 `personalExtensions` 后行为可复现。
- [子代理重复读配置] → 每个子代理扩展实例读一次小文件，可接受。
- [模块经总线注册的约定不显眼] → AGENTS.md 写明「工具必须经 `bus.register` 注册」，并加入口级测试（`test/tool-registration-entry.test.ts`）断言最终工具清单、重复注册与失败隔离。
- [总线成为所有工具的必经路径，它的 bug 影响面是全部工具] → 总线只做过滤、注册、校验、执行、错误归一化，不含业务逻辑；针对这五件事写专门的单测。
- [同一会话内切换模型不换工具面] → 已知取舍（决策 6）：`/new`、resume、fork、`/reload` 都会重新判定并换工具面，只有同一会话内 `/model` 不换；写进文档。
- [模型规则写错导致工具集整块消失] → 工具集选择命中失败时回退到 `fileIo` 缺省值；`disabledTools` 匹配不到工具时给警告，便于发现打错的名字。
- [在 `session_start` 里注册的工具赶不上该会话的工具清单计算] → pi 的内置 MCP 扩展走同一条路径（启动后注册仍会生效，`registerTool` 会触发工具注册表刷新），实现时用集成测试断言首轮就能看到工具。

## Migration Plan

1. 先把工具总线与配置读取落地，并把 8 个模块改成经总线注册（此阶段入口仍保持现状，行为不变）。
2. 新增 `src/index.ts` 并收敛 `pi.extensions`；在用户 settings 里用 `personalExtensions` 复现原有启用集（`fileIo: "claude-code"`、`disabledTools: ["web_search", ...]`）。
3. 移除 `packages[].extensions` 中的入口排除项。
4. 回滚：恢复 `pi.extensions` 的条目列表与用户的排除项即可，配置 section 可留着不用。

## Open Questions

- 是否需要项目级配置（`.pi/settings.json` 的同一 section）覆盖全局？`talk` / `sessionName` 目前都只读全局。
- 模型规则只在会话启动时判定，`/model` 切换不跟随。若以后需要跟随，需要改成"两套工具集都注册 + 切 active 列表"，并解决 `/bwrap*` 命令与 LSP 服务的重复注册。
