# Tasks

## 1. 抽出执行层 module

- [x] 1.1 新建 `src/bwrap/exec.ts`：从 `core.ts` 迁入 `BwrapInvocation`（去掉无人读取的 `cwd` 字段）、`buildBwrapInvocation`（去掉 `cwd` 形参）、`TimeoutError`（自 `network-stack.ts` 迁入）、`createBwrapBashOperations`，并新增 `invocationArgv(invocation, nsenterPid?)`（取代 `bwrapArgv`）与 `execInvocation(invocation, { holderPid, onData, signal, timeout })`（唯一的 spawn + 生命周期，采用 `settled` 守卫、错误路径清理定时器、按 pid 终止进程组）；验证：`pnpm exec tsc --noEmit` 通过。
- [x] 1.2 `src/bwrap/core.ts` 收敛为配置层：删除 1.1 迁走的导出，去掉 `node:child_process` 与 `BashOperations` 依赖；`src/bwrap/network-stack.ts` 删除 `NetworkStack.exec` 与 `NetworkStackExecOptions`，`NetworkStack` 只留 `holderPid` 与 `stop()`；验证：`pnpm exec tsc --noEmit` 通过，`grep -n "NetworkStackExecOptions\|bwrapArgs\|killChild" src/bwrap/network-stack.ts` 无匹配（该文件仍 import `node:child_process` 起 holder / slirp4netns，注释里仍以 nsenter 说明人工排查入口，与实际职责一致）。
- [x] 1.3 `src/bwrap/sandbox.ts`：`previewSandboxCommand` 改用 `invocationArgv`（holder pid 缺省时用 `HOLDER_PID_PLACEHOLDER`），`runInSandbox` 把 `NetworkStack` 传给 `createBwrapBashOperations`；验证：`pnpm exec vitest run test/bwrap-sandbox.test.ts` 通过，`previewSandboxCommand` 的 nsenter 断言（`test/bwrap-sandbox.test.ts:142-170`）不需要改断言值。

## 2. 测试

- [x] 2.1 `test/bwrap-runtime.test.ts` 的 `vi.mock` 目标从 `core.js` 改为 `exec.js`（`createBwrapBashOperations` 的 mock 位置随 D1 迁移）；验证：`pnpm exec vitest run test/bwrap-runtime.test.ts` 通过。
- [x] 2.2 新增 `invocationArgv` 单测：不带 pid → `[bwrap, ...args, "--", shell, "-lc", command]`；带 number → `nsenter -U -n --preserve-credentials -t <pid> --` 前缀；带字符串 → 原样嵌入；验证：`pnpm exec vitest run test/bwrap-sandbox.test.ts` 通过。
- [x] 2.3 新增「预览 argv 与实际执行 argv 逐项一致」测试：把配置的 `bwrapPath` 指向一个打印自身 argv 的 fake 脚本，跑 `runInSandbox`（`fs: workspace-write`，不需要 netns），断言脚本输出的 argv 等于 `previewSandboxCommand(...).argv`；验证：新增用例在 `pnpm exec vitest run test/bwrap-sandbox.test.ts` 中通过（无需真实 bwrap，仅需可执行脚本）。
- [x] 2.4 新增 direct 路径 spawn 失败断言：`bwrapPath` 指向存在但不可执行的文件，断言 `runInSandbox` 以该错误 reject，且拒绝后 `process.getActiveResourcesInfo()` 不新增 `Timeout` 条目；验证：先临时恢复旧行为（`error` 路径不 `clearTimeout`）确认该断言失败，再恢复实现后通过。
- [x] 2.5 `test/bwrap-netstack-integration.test.ts` 里直接调用 `stack.exec` 的三处改用新执行入口，并在 `network: limited` 下补一条断言：目标程序（fake bwrap）看到的 argv 等于 `invocationArgv(invocation)`，预览等于「真实 holder pid 的 nsenter 前缀 + 该 argv」（nsenter 消费自己的前缀后 exec，前缀不进目标程序的 argv）；验证：`RUN_NETSTACK_INTEGRATION=1 pnpm exec vitest run test/bwrap-netstack-integration.test.ts` 通过（需真实 nsenter / unshare / mihomo / slirp4netns）。

## 3. 文档与规范同步

- [x] 3.1 `openspec/specs/bwrap/spec.md` 的 Implementation 段按新结构改写：执行路径改为「`BwrapRuntime.execute` → `runInSandbox`（`sandbox.ts`）→ `buildBwrapInvocation` 组装（`exec.ts`）→ `execInvocation` 执行」，涉及文件列表补 `src/bwrap/exec.ts`；验证：逐条与 `src/bwrap/*.ts` 的实际调用路径对照，无与代码不符的表述。
- [x] 3.2 `openspec/specs/bwrap-network/spec.md` 的 Implementation 段改写：`nsenter` 前缀由执行层（`exec.ts`）组装，网络栈只提供 holder pid 与停止；涉及文件列表相应调整；验证：与 `src/bwrap/network-stack.ts`、`src/bwrap/exec.ts` 对照一致。
- [x] 3.3 `src/bwrap/README.md` 的进程模型与文件分工更新：短命子树的 `nsenter` 命令改标为由执行层组装，「pi 进程（network-stack.ts）」一句按新分工表述；验证：README 描述与 `exec.ts` / `network-stack.ts` 的实际职责一致。
- [x] 3.4 跑 `openspec validate refactor-bwrap-invocation-exec --strict` 通过。

## 4. 集成验证

- [x] 4.1 `pnpm check`（`tsc --noEmit` + `prettier --check`）与 `pnpm lint` 全绿（prettier 在改动完成后统一跑一次）。
- [x] 4.2 `pnpm test` 全量通过，`test/bwrap-*.test.ts` 与 `test/claude-code-tools.test.ts` 不回归。
- [x] 4.3 手动对照一次真实路径：`RUN_NETSTACK_INTEGRATION=1 pnpm exec vitest run test/bwrap-netstack-integration.test.ts` 通过，且 `pnpm sandbox --network=limited --print-args -- 'echo 1'` 的 argv 与同一命令的实际执行一致（`nsenter` 前缀只差 holder pid）。
