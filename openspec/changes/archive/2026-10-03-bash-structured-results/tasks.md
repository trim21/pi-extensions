# Tasks

## 1. claude-code 的 Bash

- [x] 1.1 `src/claude-code/shell.ts` 改成 `defineStructuredTool`，声明 `{ exitCode, output }`，四条返回路径（成功、非零退出、超时、中止）都带 `structuredResult`；截断时 `output` 取落盘文件全文（文本本身不动）；文本、`details`、抛错行为逐字不变
- [x] 1.2 `test/claude-code-tools.test.ts` 补断言：成功（`exitCode: 0` + `output` 与文本一致）、非零退出（`ok: true` + 退出码 + 文本不变）、`output` 超上限时载荷仍是全文（且不含截断提示）、超时与中止（`exitCode: null` + 部分输出）；运行 `pnpm exec vitest run test/claude-code-tools.test.ts`

## 2. opencode 的 bash

- [x] 2.1 `src/opencode/bash.ts` 同样改 `defineStructuredTool` 并构造载荷（截断时同样取全文）；`details`（`exitCode` / `truncated` / `fullOutputPath` / `timeout`）与文本不变
- [x] 2.2 `test/opencode-bash.test.ts` 补对应断言（成功 / 非零退出 / 截断 / 超时 / 中止），并断言 `details` 仍是原来的形状；运行 `pnpm exec vitest run test/opencode-bash.test.ts`

## 3. codemode：搜索工具移出可调用集合

- [x] 3.1 `src/codemode/tool.ts` 的 `EXCLUDED_TOOL_NAMES` 加入 `Grep` / `Glob` / `grep` / `glob`，并更新该常量的注释（说明脚本搜索走 `Bash` + `rg`）
- [x] 3.2 `test/codemode-tool.test.ts` 补断言：四个搜索工具名不可调用（`Tool "Grep" is not available in codemode.`），且 `codemode` 的描述里不出现它们；运行 `pnpm exec vitest run test/codemode-tool.test.ts`
- [x] 3.3 脚本侧消费验证：一条脚本 `call("Bash", { command: "rg -q needle file" })` 拿到 `{ exitCode, output }` 并按 `exitCode` 分支（`test/codemode-tool.test.ts` 用注入的桩 `Bash` 工具覆盖这一条，不真跑 rg）

## 4. 文档与整体验证

- [x] 4.1 README 与 AGENTS.md 更新：codemode 的排除名单加上搜索工具、`Bash` 的结构化结果、以及「脚本搜索走 Bash + rg」
- [x] 4.2 `pnpm check`（tsc + prettier）、`pnpm lint`、`pnpm test` 全绿
- [x] 4.3 端到端手测：真实跑一次 `Bash`（成功与非零退出）与一次 codemode 脚本里 `call("Bash", …)`，确认文本与改动前逐字一致、脚本拿到结构化结果
- [ ] 4.4 作废 `openspec/changes/grep-glob-structured-results/`（本次方向取代它）
- [x] 4.5 `openspec validate bash-structured-results --strict` 通过
