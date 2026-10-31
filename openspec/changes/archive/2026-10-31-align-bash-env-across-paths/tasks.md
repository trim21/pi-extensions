# Tasks

## 1. 执行层抽公共实现

- [x] 1.1 `src/bwrap/exec.ts` 抽出 `shellBaseEnv(extraEnv?)`，返回 `HOME` / `SHELL` / `TERM` / `LANG` / `PATH` 基础值并合并 `extraEnv`；`buildBwrapInvocation` 改为调用它，`HOME` 缺失时的错误信息不变
- [x] 1.2 把 `execInvocation` 的 spawn 主体抽成 `execArgv(argv, env, options)`，保留进程组、超时、中断、`settle` 语义；`execInvocation` 变成 `execArgv(invocationArgv(...), invocation.env, options)`
- [x] 1.3 新增 `createLocalBashOperations(extraEnv?)`：cwd 存在性检查 + `signal?.throwIfAborted()` + `execArgv([getShellConfig().shell, "-lc", command], shellBaseEnv(extraEnv), ...)`

## 2. 接入沙箱执行路径

- [x] 2.1 `src/bwrap/sandbox.ts` 改为从 `./exec.js` 导入 `createLocalBashOperations`，删除 core 的 `createLocalBashOperations` 导入与 `withExtraEnv`
- [x] 2.2 `runInSandbox` 的 `local` 分支直接调用 `createLocalBashOperations(options.env)`
- [x] 2.3 更新 `SandboxRunOptions.unsandboxed` / `env` 的注释：两条路径共用同一份干净环境，差异只在权限；`src/bwrap/README.md` 如有环境描述同步

## 3. 测试

- [x] 3.1 `test/bwrap-sandbox.test.ts` 新增：临时 `HOME` 下写 `.bash_profile`（`export LOGIN_MARKER=from-profile`），断言非沙箱路径的命令能读到 `LOGIN_MARKER`（证明 `bash -lc` 生效）
- [x] 3.2 同上文件新增：父进程环境注入标记变量（`PI_TEST_SECRET=leak`）与假 `PATH` 目录，断言非沙箱命令的 `env` 里看不到它们（证明干净环境生效）
- [x] 3.3 同上文件（真实 bwrap 分组）新增：同一条命令在沙箱路径与非沙箱路径下 `env` 逐项相同；用临时 `HOME` 隔离机器自己的 profile（那里按能否写盘/联网分支的 hook 在沙箱里会走另一条路），使失败只可能来自执行层

## 4. 整体验证

- [x] 4.1 运行 `pnpm test`、`pnpm check`、`pnpm lint`
- [x] 4.2 手工对比：同一工作区内沙箱内外 `node -v` / `pnpm -v` 一致，`env` 变量集合一致

## Workflow follow-up

- [ ] 归档后把 `openspec/specs/bwrap/spec.md` 的 `命令执行环境` 更新为本次 delta 的最终文本
