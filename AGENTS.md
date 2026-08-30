# AGENTS.md — pi-extensions

pi-extensions 是 pi coding-agent 的自定义扩展集合，TypeScript ESM 项目，包管理用 pnpm。

## 开发约定

- 包管理与脚本一律使用 `pnpm`（`pnpm install`、`pnpm test`、`pnpm lint`、`pnpm check`），不要使用 `npm` / `npx`。
- 不使用 emoji，除非用户明确要求。代码、注释、UI 文案和回复中都不添加 emoji。
- 代码风格由 Prettier 管理，提交前运行 `pnpm check`（`tsc --noEmit` + `prettier --check`）与 `pnpm lint`。
- 测试使用 Vitest，新增功能需补充对应测试，运行 `pnpm test` 验证；测试文件放在 `test/`，命名与 `src/` 对应（如 `src/opencode/edit.ts` → `test/opencode-edit.test.ts`）。
- 提交时 husky + lint-staged 自动运行 `eslint --fix` 与 `prettier --write`，本地仍须保证 `pnpm check` 与 `pnpm lint` 全绿。
- TypeScript 只允许 erasable 语法（`eslint-plugin-erasable-syntax-only`）：不用 `enum`、`namespace`、参数属性等非可擦除语法。
- 优先用函数声明语法 `function name(...)`，而不是给变量赋值箭头函数（`const name = (...) => ...`）。
- import 排序由 `eslint-plugin-simple-import-sort` 强制：副作用导入 → `node:` 内置 → 第三方包 → 相对导入。
- 相对导入必须带 `.js` 后缀（ESM + Node16 moduleResolution），如 `import { x } from "./lib/pendant.js"`。
- 文件系统访问一律使用 `node:fs/promises`（async API），不要用 `node:fs` 的同步版本；除非在特别必要的同步上下文（如顶层脚本、必须同步的初始化）中才允许例外。
- 解析 JSON / YAML 等外部数据必须用 typebox schema + `Value.Parse` 做解析与验证（必要时用 `Type.Transform` 做类型转换），不要手写解析和校验代码。
- Node 版本要求 `>=24`；`typescript` 通过 npm alias 安装，不要随意改动依赖版本与锁文件。

## 项目结构

```
src/
├── aft/          # AFT 只读代码感知工具（outline/zoom/callgraph/search，index.ts 为扩展入口）
├── bwrap/        # bubblewrap 沙箱执行层（被 claude-code / opencode 的 Bash 工具复用）
├── claude-code/  # Claude Code 风格工具集（index.ts 为扩展入口；files.ts 内含 LSP 诊断与 lsp-rename）
├── lib/lsp/      # LSP 客户端层（连接、诊断、rename；服务器由 lsp.json 声明，kind 区分 language / linter）
├── opencode/     # opencode 风格工具集（index.ts 为扩展入口）
├── lib/          # 跨扩展共享工具（cli、path、pendant、ui、write-guard）
├── talk/         # agent 间通信（SQLite 邮箱）
├── openai-cost/  # OpenAI Chat Completions，费用取自 usage.cost
└── *.ts          # 单文件扩展（gh-readonly、session-name、spawn-agent、vision-agent）
test/             # Vitest 测试，文件与 src 对应
```

- `claude-code` 与 `opencode` 是两套平行的工具集，由用户在 pi 配置里选择**启用其中一个**，不会同时启用；两者在行为、命名上的差异与冲突是符合预期的，不要试图统一。
- 扩展没有单一根入口，各目录的 `index.ts` 作为扩展入口，在 `package.json` 的 `pi.extensions` 中注册；skills 在 `pi.skills` 中注册；`src/bwrap/` 不单独注册。
- `aft` 只注册只读感知工具（outline / zoom / callgraph / search）。引擎自带的回滚面（`aft_safety` 的 undo / history / checkpoint / restore）、OS 级文件操作（`aft_delete` / `aft_move`）与写类命令不暴露给模型——模型只负责感知与改，恢复由用户用 git 完成；prompt 里也不要提「快照」「撤销」这类模型用不了的概念。`aft_search` 只走外部 embedding 后端（`openai_compatible` / `ollama`），本地 ONNX 的 `fastembed` 不注册。
- `lsp-rename` 工具注册在 `claude-code/files.ts`（与 Read/Edit/Write 并列），基于 `src/lib/lsp/` 的 LSP 客户端做符号重命名；只面向 lsp.json 里 `kind: "language"` 的服务器，`linter` 类（如 ruff）只参与诊断。

## pi 扩展约定

- 工具 `execute` 返回的 `details.pendant` 是本仓库 UI 约定（非 pi 官方 schema），可折叠 markdown 面板，类型定义在 `src/lib/pendant.ts`，统一从 `./lib/pendant.js` 导入，禁止内联字面量。`expanded: true` 用于需立即看到的结果，`false` 用于常驻信息。
- 修改扩展后需重启 pi agent 才能生效。
- 开发 pi 扩展遇到 API / SDK 问题，参考 pi 主仓库 `/srv/ssd-1/projects/github/earendil-works/pi`（`AGENTS.md`、`packages/coding-agent/src/`、`extensions/`）。
