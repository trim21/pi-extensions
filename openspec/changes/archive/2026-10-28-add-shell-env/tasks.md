# Tasks

## 1. 配置解析

- [x] 1.1 `src/lib/tools-config.ts` 增加 `shell.env` 的 typebox schema 与逐键解析，`ToolsConfig` 暴露 `shellEnv: Readonly<Record<string, string>>`；`test/tools-config.test.ts` 覆盖：正常解析、未配置为空、`shell` 非对象、`env` 非对象、值非字符串（逐键跳过并给出含键名的 warning）、其余配置不受影响
- [x] 1.2 README「工具启用配置」的 `personalExtensions` 示例补上 `shell.env`（含覆盖基础变量与「新会话生效」的说明），核对示例 JSONC 与代码行为一致

## 2. 执行层注入

- [x] 2.1 `src/bwrap/exec.ts`：`buildBwrapInvocation` 接受可选 env 并合并进沙箱环境（配置优先），`createBwrapBashOperations` 透传；`test/bwrap-sandbox.test.ts` 增加沙箱内 `printf %s "$GIT_EDITOR"` 得到注入值与覆盖基础值（如 `LANG`）的用例
- [x] 2.2 `src/bwrap/sandbox.ts`：`SandboxRunOptions.env` 透传；非沙箱路径在 env 非空时包一层 local ops 传 `{...process.env, ...env}`，为空时保持现有默认行为；补一条非沙箱路径的用例
- [x] 2.3 `src/bwrap/runtime.ts`：`BwrapRuntime` 构造器与 `createBwrapRuntime` 接受 env 并放进 `runInSandbox` 请求；`test/bwrap-runtime.test.ts` 断言 env 到达执行层（走 mock 记录参数）

## 3. 注入点接线

- [x] 3.1 `src/lib/tool-services.ts` 的 `ToolServicesOptions` 增加 `shellEnv`，`src/index.ts` 与 `src/spawn-agent.ts` 从 `registration.config.shellEnv` 传入；`test/tool-services.test.ts` 断言传参到达 runtime
- [x] 3.2 独立入口 `src/claude-code/index.ts`、`src/opencode/index.ts`、`src/opencode/bash.ts` 默认导出各自 `readToolsConfig().shellEnv` 后传给 `createBwrapRuntime`；用一条测试或 `pnpm check` + 现有入口测试确认无回归

## 4. 集成验证

- [x] 4.1 在 `test/claude-code-tools.test.ts`（或等价端到端用例）配置 `shell.env` 后跑一条真实命令，断言 `Bash` / `bash` 两个工具都能看到注入变量
- [x] 4.2 运行 `pnpm check`、`pnpm lint`、`pnpm test`，确认全绿；检查 `git diff` 无无关改动

## Workflow follow-up

- 实现完成后按项目流程用 `openspec-archive-change` 归档本 change。
