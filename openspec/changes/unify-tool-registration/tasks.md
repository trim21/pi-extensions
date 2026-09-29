# Tasks

## 1. 工具总线与配置

- [x] 1.1 新增 `src/lib/tool-bus.ts`：`createToolBus(pi, config)` 返回 `{ register, list, get, executeTool }`——`register` 按配置过滤后交给 `pi.registerTool` 并保留定义，`executeTool(name, args, opts)` 做参数校验、调用定义的 `execute`、把校验失败与抛错归一化成错误结果而不是抛出；验证：`test/tool-bus.test.ts` 覆盖过滤、查询、执行、校验失败与抛错归一化
- [x] 1.2 新增配置读取：用 typebox schema + `Value.Parse` 读 `~/.pi/agent/settings.json` 的 `personalExtensions`（`fileIo` 缺省 `claude-code`、`fileIoByModel` 按顺序取首条命中、`disabledTools` / `enabledTools` 条目为模式字符串或 `{ tools, models }`），工具名与模型名用 `minimatch` 匹配（模型名同时试 `model.id` 与 `provider/model`），非法条目回退/忽略、匹配不到任何已注册工具的模式也产出警告文本；验证：单测覆盖缺省、通配、`fileIoByModel` 命中与未命中回退、`enabledTools` 豁免、非法 `fileIo`、非数组字段、未知工具名

## 2. 模块改造为经总线注册

- [x] 2.1 claude-code 组（`files.ts` 的 Read/Edit/Write、`glob.ts`、`grep.ts`、`shell.ts`、`session-tools.ts`、`lsp-rename`）改为经 `bus.register` 注册，并保留 `export default function xxx(pi)`（内部自建 bus）；验证：模块既有单测通过，且默认导出被直接调用后 `bus.list()` 含该模块声明的全部工具
- [x] 2.2 opencode 组（`files.ts`、`glob.ts`、`grep.ts`、`bash.ts`）同上；验证：同上
- [x] 2.3 `aft/tools.ts`、`gh/tools/*`、`talk/index.ts`、`web/search.ts`、`web/fetch.ts`、`spawn-agent.ts`、`vision-agent.ts` 同上；验证：同上，并断言注册阶段不建连接/进程（aft bridge、talk SQLite、LSP、gh token 均在首次执行时才建立）

## 3. 单一入口与配置生效

- [x] 3.1 新增 `src/index.ts`：在每次 `session_start` 里用 `ctx.model` 判定生效工具集（`fileIoByModel` 首条命中，否则 `fileIo`）与禁用集合，创建 bus、按生效工具集调用对应那套模块、依次调用其余模块，每个模块 try/catch 收集失败警告，并用 `ctx.ui.notify` 上报配置与注册警告；验证：入口级测试覆盖两套工具集各一次、`disabledTools` / `enabledTools` / 模型条件生效、模块抛错时其余工具仍注册且产生警告、两个不同模型的会话各自得到对应工具集
- [x] 3.2 `package.json` 的 `pi.extensions`：注册工具的分入口由 `src/index.ts` 取代，`src/session-name.ts` 与 `src/system-prompt/index.ts` 保持不动；验证：`pnpm check` 通过，且用 pi 的加载器加载该列表后工具清单与 3.1 的断言一致
- [x] 3.3 `src/spawn-agent.ts` 的子代理工具加载改为 inline 工厂 + 统一 loadout（同 Bash 工具现有的传参注册方式）：用 `工具名 → 注册函数` 的映射替代 `TOOL_EXTENSION_OVERRIDES` 的按文件 `-e` 加载，一个扩展实例内建一份 registration（与主入口同一套 register 函数），只为该 agent 声明的工具注册，sandbox 仍经闭包注入 `registerShellTools` 的 runtime；被 `disabledTools`（按子代理模型判定）禁用的工具既不注册也不进 `createAgentSession` 白名单；`additionalExtensionPaths` 与 `overrideExtensionPaths` 随之移除；验证：单测覆盖「声明 Read+Grep 只得到这两个工具」「声明被禁工具拿不到且不加载其模块」「Bash 仍带 per-agent sandbox」「共享同一总线（脚本/工具能看到彼此）」

## 4. 迁移与文档

- [x] 4.1 `README.md` 与 `AGENTS.md`：`personalExtensions` 配置说明（含通配、`fileIoByModel` 按模型选工具集、`disabledTools` / `enabledTools` 的示例）、入口收敛说明、`packages[].extensions` 排除项到新配置的对照表、模型规则只在会话启动时判定（换模型需开新会话）、模块默认导出的约定（自建 bus 并注册）；验证：文档描述与实现一致，配置示例可直接粘贴使用
- [x] 4.2 真实验证：分别以 `fileIo: "claude-code"` 与 `"opencode"` 启动会话确认工具清单，用 `fileIoByModel` 指定一个模型确认工具名随模型变化，禁用一项工具确认模型看不到，子代理声明被禁工具确认拿不到；验证：会话工具清单与工具调用结果核对

## 5. 集成验证

- [x] 5.1 运行 `pnpm check`、`pnpm lint`、`pnpm test` 全绿；验证：三条命令输出无错误
