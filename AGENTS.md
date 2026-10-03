# AGENTS.md — pi-extensions

pi-extensions 是 pi coding-agent 的自定义扩展集合，TypeScript ESM 项目，包管理用 pnpm。

## openspec 变更流程

本项目由 openspec 管理：`openspec/specs/` 是各功能当前行为的规范文档，`openspec/changes/` 存放尚未落地的变更提案。

- 任何代码改动（`src/`、`test/`）都必须先有对应的 openspec change：用 `openspec-propose` 在 `openspec/changes/` 下写出 proposal（必要时要补 design 与 spec delta），经用户认可后再实现，完成后用 `openspec-archive-change` 归档。不允许不经 openspec 直接修改代码。
- 行为变更必须同步到 spec，不要只改代码、把 spec 留在旧行为上。
- `openspec/specs/` 描述的是当前真实行为；发现 spec 与代码不符时，先查清哪边为准，再按上面的流程修正，不要单方面改。

## 开发约定

- 包管理与脚本一律使用 `pnpm`（`pnpm install`、`pnpm test`、`pnpm lint`、`pnpm check`），不要使用 `npm` / `npx`。
- 不使用 emoji，除非用户明确要求。代码、注释、UI 文案和回复中都不添加 emoji。
- 代码风格由 Prettier 管理，提交前运行 `pnpm check`（`tsc --noEmit` + `prettier --check`）与 `pnpm lint`。
- 一轮修改完成后再运行一次 `prettier` 统一格式化，修改过程中不要反复运行 prettier。
- 测试使用 Vitest，新增功能需补充对应测试，运行 `pnpm test` 验证；测试文件放在 `test/`，命名与 `src/` 对应（如 `src/opencode/edit.ts` → `test/opencode-edit.test.ts`）。
- 提交时 husky + lint-staged 自动运行 `eslint --fix` 与 `prettier --write`，本地仍须保证 `pnpm check` 与 `pnpm lint` 全绿。
- TypeScript 只允许 erasable 语法（`eslint-plugin-erasable-syntax-only`）：不用 `enum`、`namespace`、参数属性等非可擦除语法。
- 优先用函数声明语法 `function name(...)`，而不是给变量赋值箭头函数（`const name = (...) => ...`）。
- import 排序由 `eslint-plugin-simple-import-sort` 强制：副作用导入 → `node:` 内置 → 第三方包 → 相对导入。
- 相对导入必须带 `.js` 后缀（ESM + Node16 moduleResolution），如 `import { x } from "./lib/pendant.js"`。
- 文件系统访问一律使用 `node:fs/promises`（async API），不要用 `node:fs` 的同步版本；除非在特别必要的同步上下文（如顶层脚本、必须同步的初始化）中才允许例外。
- 解析 JSON / YAML 等外部数据必须用 typebox schema + `Value.Parse` 做解析与验证（必要时用 `Type.Transform` 做类型转换），不要手写解析和校验代码。
- 不要用 module 级可变变量（如 `let x: T | undefined` 在模块顶层）维护跨调用状态。需要记住状态（client、缓存、单例等）时，用工厂函数 + 闭包：`createX()` 返回带内部状态的对象/函数，状态由闭包持有，生命周期随创建者。
- Node 版本要求 `>=24`；`typescript` 通过 npm alias 安装，不要随意改动依赖版本与锁文件。

## 术语

- **toolcall 进度**：工具 `execute` 的 `onUpdate` 回调被调用时传入的内容。文档、注释与回复中一律用这个说法指代它。
- **toolcall 输出**：工具 `execute` 返回值里的 `content` 部分（`{ content: [...] }`），即真正进入 LLM 上下文的内容；同级的 `details` 不算输出。文档、注释与回复中一律用这个说法指代它。

## 项目结构

```
src/
├── index.ts      # 唯一注册工具的扩展入口：按 personalExtensions 配置选工具集/过滤工具
├── aft/          # AFT 只读代码感知工具（outline/zoom/callgraph/search）
├── bwrap/        # bubblewrap 沙箱执行层（被 claude-code / opencode 的 Bash 工具复用）
├── claude-code/  # Claude Code 风格工具集（files.ts 内含 LSP 诊断与 lsp-rename）
├── codemode/     # QuickJS 沙箱工具（worker 线程执行脚本，嵌套调用走 tool bus）
├── gh/           # GitHub 只读工具集（index.ts 注册、base.ts 共享层、tools/ 每工具一个文件）
├── lib/lsp/      # LSP 客户端层（连接、诊断、rename；服务器由 lsp.json 声明，kind 区分 language / linter）
├── opencode/     # opencode 风格工具集
├── openai-cost/  # OpenAI Chat Completions，费用取自 usage.cost
├── skills/       # 随扩展注册的 skills（coding-style、github-ci-logs、lsp-config 等）
├── system-prompt/# 系统提示词扩展
├── talk/         # agent 间通信（SQLite 邮箱）
├── web/          # web_fetch / web_search
├── lib/          # 跨扩展共享工具（cli、path、pendant、ui、write-guard、tool-bus、tools-config、tool-registration、tool-services、tool-units、bash-tool、abort）
└── *.ts          # 单文件模块（session-name、spawn-agent、vision-agent 等）
test/             # Vitest 测试，文件与 src 对应
```

- **所有工具由 `src/index.ts` 一个入口注册**（`pi.extensions` 只列它 + `session-name` + `system-prompt`）：pi 给每个扩展入口单独的模块图，集中在一处才有唯一的配置求值点，也才能让同入口的模块直接调用别的工具。
- 注册流程：`personalExtensions` 配置（`src/lib/tools-config.ts`）→ 总线（`src/lib/tool-bus.ts`，`register` / `list` / `get` / `executeTool`）→ 各模块的 `registerXxx(bus, ...)`。**工具一律经 `bus.register(def)` 注册，不要再直接调 `pi.registerTool`**（否则 `disabledTools` 过滤会漏掉它）。
- `ToolUnit` 表（`src/lib/tool-units.ts`）描述「哪些工具名由哪个单元提供」，主入口与 spawn-agent 的子代理共用它。
- `codemode`（`src/codemode/`）在注册时编译 `quickjs-wasi` 的 wasm 一次，每次调用起一个 worker 线程跑脚本；脚本里的工具调用经 `bus.executeTool` 执行，因此审批由各工具自己负责（codemode 不加确认层）。worker 入口是 esbuild 产物 `src/codemode/worker.js`，由 `pnpm run build:codemode-worker` 生成（pre-commit 会跑），因为它需要是单文件才能作为 worker 路径启动；该产物必须**自包含**（`--bundle --platform=node --external:quickjs-wasi`），它由 `new Worker(url)` 当普通 Node 模块加载，不走 jiti，解析不到 pi 提供的依赖（typebox 就是这样在发布后报 `Cannot find package` 的），回归测试见 `test/codemode.test.ts` 的「worker 产物」。
- `claude-code` 与 `opencode` 是两套平行的文件 IO 工具集，由 `personalExtensions.fileIo`（可带 `fileIoByModel` 按模型覆盖）**二选一**；两者在行为、命名上的差异与冲突是符合预期的，不要试图统一。共享部件（请求策略、bwrap runtime、LSP manager、reads 恢复）由 `src/lib/tool-services.ts` 持有并注入，模块自己不要再建一份（会重复注册 `/bwrap*`、`/lsp-*` 命令）。
- 注册时机是**每次会话启动**（`session_start`）：pi 在启动 / `/new` / `resume` / `/fork` / `/reload` 时重建扩展；模型只在事件上下文里（`ctx.model`），加载期读不到，所以「按模型判定」必须放在 `session_start` 里。同一会话内 `/model` 切换不重新判定。
- spawn-agent 的子代理用 inline 扩展工厂（`subagentToolsExtension`）注册声明的工具，不再走 `-e` 路径加载。
- skills 在 `pi.skills` 中注册；`src/bwrap/` 不单独注册。
- `aft` 只注册只读感知工具（outline / zoom / callgraph / search）。引擎自带的回滚面（`aft_safety` 的 undo / history / checkpoint / restore）、OS 级文件操作（`aft_delete` / `aft_move`）与写类命令不暴露给模型——模型只负责感知与改，恢复由用户用 git 完成；prompt 里也不要提「快照」「撤销」这类模型用不了的概念。codemode 的可调用集合只收**声明了 `structuredSchema`** 的工具（`src/codemode/tool.ts` 的准入条件）：没有结构化输出的工具不进集合，脚本搜文件走 `Bash` + `rg`，读文件走 `fs` 原语。`aft_search` 只走外部 embedding 后端（`openai_compatible` / `ollama`），本地 ONNX 的 `fastembed` 不注册。
- `lsp-rename` 与 LSP inspect 族工具注册在 `claude-code/files.ts` / `opencode/files.ts`（与文件工具并列），由选中的工具集在 LSP manager 触发 `onLspEnabled` 时注册，基于 `src/lib/lsp/` 的 LSP 客户端做符号重命名；只面向 lsp.json 里 `kind: "language"` 的服务器，`linter` 类（如 ruff）只参与诊断。

## pi 扩展约定

- 工具 `execute` 返回的 `details.pendant` 是本仓库 UI 约定（非 pi 官方 schema），可折叠 markdown 面板，类型定义在 `src/lib/pendant.ts`，统一从 `./lib/pendant.js` 导入，禁止内联字面量。
- 修改扩展后需重启 pi agent 才能生效。
- 开发 pi 扩展遇到 API / SDK 问题，参考 pi 主仓库 `/srv/ssd-1/projects/github/earendil-works/pi`（`AGENTS.md`、`packages/coding-agent/src/`、`extensions/`）。
