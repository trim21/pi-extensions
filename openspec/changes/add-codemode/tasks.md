# Tasks

> 前置：`unify-tool-registration` 先落地（单一入口 + 工具总线 + `personalExtensions` 配置）。

## 1. 依赖与构建

- [ ] 1.1 `package.json` 新增运行期依赖 `@earendil-works/pi-codemode`；**不动** pi 相关依赖与 peerDependencies；验证：`pnpm install` 成功，`pnpm exec tsc --noEmit` 通过（`@earendil-works/pi-codemode` 类型可解析）
- [ ] 1.2 新增 helper 构建脚本（沿用 `build:holder` 模式，如 `build:codemode-child`）：esbuild 把 `src/codemode/sandbox-child.ts` 打成单文件 `src/codemode/sandbox-child.js` 并提交，依赖包保持 external；验证：`pnpm build:codemode-child` 产出文件，`node --check src/codemode/sandbox-child.js` 通过

## 2. 沙箱进程与父子协议

- [ ] 2.1 定义并实现父子 NDJSON 协议（子→父 `call` / `output` / `done`；父→子 `result` / `error` / `cancel`），编解码与校验做成纯函数；验证：`test/codemode.test.ts` 覆盖正常帧、被拆分的部分帧、超长行、非法帧，单测通过
- [ ] 2.2 实现 `src/codemode/sandbox-child.ts`：从 stdin 读协议帧，用 `@earendil-works/pi-codemode` 的沙箱跑脚本，把 `tools.*` 调用转发给父进程、把输出与结束帧发回；验证：测试内父进程 spawn 该 helper（不沙箱）执行一次 `await tools.<name>()`，断言调用参数、返回注入与输出项
- [ ] 2.3 实现 bwrap 启动路径：`resolveBwrap` 固定为只读根 + 断网，用 `buildBwrapArgs` 组装参数、`findBwrap` 定位可执行文件，再用 `--tmpfs` 遮蔽 workspace 与 agent 敏感路径（`auth.json`、`mcp-auth.json`、`sessions/`、`tmp/`），随后只读回挂 helper、`@earendil-works/pi-codemode` 与 node 所需的最小路径；验证：集成测试里脚本读不到工作区文件与 `auth.json`、网络请求失败
- [ ] 2.4 实现超时、中止与进程组终止：`// @options:` 的 `timeout_ms` 与调用方 signal 触发时向进程组发 SIGKILL 并等待收敛；验证：死循环脚本超时后返回失败且保留部分输出，断言该次执行的进程全部退出
- [ ] 2.5 bwrap 不可用时的降级：仍以普通子进程执行，并在工具结果里标注本次未隔离；验证：注入 `findBwrap` 不可用的环境，结果文本含未隔离说明

## 3. 工具行为与确认

- [ ] 3.1 工具定义：`parameters` 为 `{ code: string }`、`constrainedSampling` 用 pi-codemode 的源码 grammar、按 `// @options:` 解析 `max_output_tokens` 与 `timeout_ms`、描述由 `bus.list()` 渲染并排除 `codemode` 自身；验证：单测断言描述覆盖总线上全部工具有声明、不含 `codemode`，且脚本调用 `codemode` 被拒
- [ ] 3.2 嵌套调用分发：每次 `call` 帧经 `bus.executeTool` 执行（复用模型直调时的 `ctx`），执行前用 `pi.getActiveTools()` 过滤未启用的工具，只读集合（`Read`/`Glob`/`Grep` 或 `read`/`glob`/`grep`）直接执行、其余逐次用 `selectWithOptionalInput` 确认、无 UI 时拒绝；确认被拒只让该次调用在脚本内失败；验证：单测覆盖只读放行、两次写类各确认一次、拒绝后脚本可捕获错误、无 UI 拒绝、未启用工具被拒，以及工具自身写入审批仍会触发（工作区外写入用例）
- [ ] 3.3 `store` / `load` 落 session custom entry（类型 `codemode-store`）：脚本开始时注入当前值、成功结束后用 `pi.appendEntry` 写回；验证：单测覆盖跨调用读取、失败脚本的写入不保留
- [ ] 3.4 结果与错误语义：输出项与返回值进入 toolcall 输出，失败结果保留部分输出并附脚本内报错位置，`max_output_tokens` 只约束直接返回给模型的部分；验证：对应单测通过
- [ ] 3.5 文档：`README.md` 与 `AGENTS.md` 补 `src/codemode/`，说明与 pi 内置 codemode 的差异与已知限制（经我们的工具总线执行、不触发其他扩展的 `tool_call` / `tool_result` 钩子、只能调用总线上注册的工具、无 `models.classify` 与 `codemode.mode: "only"`）；验证：文档描述与实际行为一致，命令与路径可按文执行

## 4. 集成验证

- [ ] 4.1 运行 `pnpm check`、`pnpm lint`、`pnpm test` 全绿；验证：三条命令输出无错误
- [ ] 4.2 在真实会话里跑一次 codemode 脚本：并行读取若干文件、调用一次搜索、发起一次写类调用并确认后完成；确认模型上下文里只有脚本输出、嵌套调用不出现在会话记录、结束后无残留进程；验证：会话记录与 `ps` 输出核对
