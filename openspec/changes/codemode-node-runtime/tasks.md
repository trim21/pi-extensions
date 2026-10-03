# Tasks

## 1. bwrap 命令组装泛化为 argv

- [x] 1.1 把 `src/bwrap/exec.ts` 的 `BwrapInvocation` 从 `shell` + `command` 改为 `commandArgv: string[]`，`buildBwrapInvocation` 接收 argv，Bash 的调用方（`createBwrapBashOperations`、`bin/sandbox.ts` 的 `--print-args`）改成传 `[shell, "-lc", command]`；`pnpm exec vitest run test/bwrap-sandbox.test.ts test/bwrap-netstack-integration.test.ts` 通过，且 `pnpm run sandbox --print-args -- echo 1` 打印的命令行与改动前逐字一致
- [x] 1.2 新增「非 shell 命令」的组装用例：断言 argv 直接追加在 `--` 之后、参数无 shell 转义、`invocationArgv` 在传入 holder pid 时前面是 `nsenter … --`；`test/bwrap-sandbox.test.ts` 通过

## 2. codemode 子进程运行时（宿主侧）

- [x] 2.1 `src/codemode/protocol.ts` 改为「子进程通道协议」：帧 schema（`ready` / `call` / `output` / `done`）、带 magic 与长度的分帧编码、以及一个能跳过垃圾字节重新同步的增量解析器；新增 `test/codemode-protocol.test.ts` 覆盖半帧、多帧粘连、magic 前有噪声、伪造帧，`pnpm exec vitest run test/codemode-protocol.test.ts` 通过
- [x] 2.2 重写 `src/codemode/sandbox.ts` 为子进程客户端：用 `spawnSandboxed` 起 `bwrap … node bootstrap.js`（stdio 里多开一条全双工 socketpair 作协议 fd）、经它收帧回帧、把脚本 stdio 收集成输出、中止时杀掉整个进程组；`SandboxOutcome` 对外形状保持不变，`test/codemode.test.ts` 的既有语义用例（工具调用、输出、返回值、store、中止）在新运行时下通过
- [x] 2.3 无 bwrap 的路径：`resolveBwrap` / `findBwrap` 找不到 bwrap（或 spawn 报 ENOSPC/EPERM 之类的启动失败）时，先查请求策略，再向用户请求一次授权（选择项与 `write-guard` 的审批界面风格一致）、按会话缓存结果；headless 会话、Windows、`/bwrap-deny-request` 生效时直接拒绝；`test/codemode-sandbox-mode.test.ts` 用注入的假 resolver 覆盖「拒绝授权不执行」「headless 直接拒绝」「授权后以普通子进程执行并跑通脚本」三条，通过
- [x] 2.4 `test/codemode.test.ts` 里「死循环 / 中止」「子进程无残留（失败、成功、中止三条路径后不存在同名进程）」的用例在新实现下通过；无 bwrap 的环境（macOS、受限容器）下这组用例 `it.skipIf` 跳过而不是失败

## 3. 脚本侧 bootstrap 与接口

- [x] 3.1 `src/codemode/prelude.ts` 换成 `bootstrap.ts` + esbuild 产物 `bootstrap.js`（只 import `node:` 内置与 `./protocol.js` 的类型）：注入 `call` / `CallFailedError` / `ALL_TOOLS` / `text` / `image` / `exit` / `console` / `store`，用 `new Function` 求值脚本，经协议 fd 收发 `ready` / `call` / `output` / `done` / `start` / `result`；`pnpm exec vitest run test/codemode.test.ts` 中「call 成功 / 失败统一是 CallFailedError / 未知工具名 / 动态工具名 / store 读写 / text 与 return」全部通过
- [x] 3.2 脚本自己的 stdout / stderr 输出进入工具结果（宿主收集子进程的 stdio；`console.*` 由 bootstrap 的代理走协议帧以保证与 `text()` 同序），`test/codemode.test.ts` 用「脚本 `console.log` + 直接写 `process.stdout` / `process.stderr` + 向协议 fd 写垃圾字节」验证输出内容正确、嵌套调用照常
- [x] 3.3 执行上限：宿主侧按 `timeoutMs`（缺省 120 s，`@options.timeout_ms` 可覆盖）计时，到点杀掉进程组并以 `kind: "timeout"` 结束，消息给出当前上限与放宽方式；上限从子进程起好之后开始算（无沙箱授权的等待不计入）。`test/codemode.test.ts` 覆盖「超过 timeoutMs 被杀掉」「脚本自己挂着的 timer 挡不住超时」「超时前结束不受影响」，`test/codemode-tool.test.ts` 覆盖 `@options.timeout_ms` 的放宽与非法值
- [x] 3.4 `src/codemode/declarations.ts` 与 `src/codemode/tool.ts` 去掉 `fs` 声明、在工具描述里说明脚本跑在 Node 运行时（可用 `node:fs` 等内置能力）且文件读写工具不可调用；`test/codemode-tool.test.ts` 的「描述列出可调用工具」「描述给出返回类型」「文件读写工具不可调用」断言更新后通过

## 4. 删除旧运行时与相关接线

- [x] 4.1 删除 `src/codemode/worker.ts`、`src/codemode/worker.js`、`src/codemode/wasm.ts`、`src/codemode/fs.ts`、`src/codemode/prelude.ts` 与 `package.json` 的 `build:codemode-worker`（改为 `build:codemode-bootstrap`，并在 `.husky/pre-commit` 里生成与入暂存），删除 `test/codemode-fs.test.ts`；`pnpm exec tsc` 无未使用导入报错，`grep -rn "quickjs-wasi" src/ package.json` 无残留，`quickjs-wasi` 从 dependencies 移除
- [x] 4.2 撤掉脚本与文件工具的记账互锁：`src/claude-code/files.ts` 与 `src/opencode/files.ts` 去掉为共享记账暴露的 `readonly reads`、`restoreReads` 的 `"codemode"` 条目，`src/index.ts` 不再向 `createCodemodeTools` 注入 policy 与 reads，codemode 结果不再带 `details.reads`；`pnpm exec vitest run test/codemode-tool.test.ts test/claude-code-tools.test.ts test/opencode-tools.test.ts` 通过，`git grep -n "CODEMODE_TOOL_NAME\|details.reads" src/` 只剩该删的残留为零
- [x] 4.3 更新 README 与 AGENTS.md 的 codemode 段落：运行时是 bwrap 里的 Node 子进程、协议走一条全双工专用 fd、沙箱配置与 Bash 同一份、无 bwrap 时的授权路径、bootstrap 产物由 `build:codemode-bootstrap` 生成；`pnpm check` 中 prettier 对文档无改动即通过

## 5. 集成验证

- [x] 5.1 端到端跑通一篇脚本：一次调用里用 `node:fs` 读工作区内文件并写回另一个文件、`call("Bash", …)` 一次、`store.set` 一次；确认输出与返回值正确、`details.calls` 记录正确、脚本产生的文件真的落盘；把沙箱配置切成只读后同一脚本的写操作以沙箱错误失败，把 network 切成拒绝后脚本出网以错误失败
- [x] 5.2 `pnpm check`（tsc + prettier）、`pnpm lint`、`pnpm test` 全绿；`openspec validate codemode-node-runtime --strict` 通过；归档时把 `openspec/specs/codemode/spec.md` 的 Purpose 段落从「QuickJS VM」更新为新的运行时描述
