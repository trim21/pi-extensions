# Tasks: add-lsp-inspect-tools

## 1. client 层

- [x] 1.1 `src/lib/lsp/client.ts`：新增 `InspectPositionRequest` / `InspectLocation` 类型与 `LspMethodNotSupportedError`；`LspClient` 接口新增 `definition` / `references` / `hover` 三个方法（hover contents 原样透传）。验证：`pnpm exec tsc --noEmit` 通过
- [x] 1.2 实现三个请求：复用 openDocument 前置同步与 `retryOnContentModified`；`textDocument/definition` 的 Location | Location[] | LocationLink[] | null 全形状归一化（LocationLink 缺 `targetSelectionRange` 时回退 `targetRange`，非 file: URI 跳过）；MethodNotFound 抛 `LspMethodNotSupportedError`。验证：步骤 3 的 client 单测通过

## 2. 服务层与工具壳

- [x] 2.1 `src/lib/lsp/lsp.ts`：`LspService` 接口新增 `inspect` 分发（仅 `kind: "language"`、配置顺序首个成功、MethodNotFound 跳到下一服务器、全不支持聚合报错）。验证：`pnpm exec tsc --noEmit` 通过
- [x] 2.2 新增 `src/lib/lsp/inspect-tool.ts`：注册 `lsp-find-definition` / `lsp-find-reference` / `lsp-inspect` 三个工具；复用 `symbolCandidates` 候选枚举与逐候选探测，以格式化输出为分组键做同名消歧；definition/references 输出 1-based 坐标 + 行片段（per-call 文件行缓存）；references 按文件分组、附总数、按上限截断并显式标注（每文件 10 条、30 个文件）；hover 原样透传（MarkedString 数组转 code fence）。验证：步骤 4 的 e2e 通过
- [x] 2.3 `src/claude-code/files.ts` 与 `src/opencode/files.ts` 各加一行注册；`src/spawn-agent.ts` 注释同步。验证：`pnpm exec tsc --noEmit` + 两工具集加载后 `lsp-inspect` 工具名出现

## 3. 测试

- [x] 3.1 新增 `test/fixtures/lsp-project/` fixture project（lib.ts / main.ts / amb.ts + .pi/lsp.json，vtsls），不扩展 mock-lsp-server.mjs；验证：fixture 文件齐备
- [x] 3.2 新增 `test/lsp-e2e-inspect.test.ts`（真实 vtsls，缺二进制跳过；索引未就绪时轮询重试到跨文件结果）：跨文件 find-definition（import 处 → lib.ts 定义行 + 行片段）、find-reference（含声明处、分组与总数）、lsp-inspect（hover 含类型签名）、行上无符号报错、同名歧义报错 + character 消歧。验证：`pnpm test -- lsp-e2e-inspect` 通过

## 4. 全量验证

- [x] 4.1 `pnpm check`（tsc --noEmit + prettier --check）与 `pnpm lint` 全绿
- [x] 4.2 `pnpm test` 全量通过（928 passed，不回归）
