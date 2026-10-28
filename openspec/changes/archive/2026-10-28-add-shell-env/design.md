# Design

## Context

Bash 的进程环境目前由两处各自决定：

- 沙箱路径：`buildBwrapInvocation` 写死一份干净环境（`HOME`/`SHELL`/`TERM`/`LANG`/`PATH`），bwrap 不带 `--clearenv`，spawn 的 env 就是沙箱内 shell 的初始环境，随后 `bash -lc` 从 profile 重建 PATH。
- 非沙箱路径：`runInSandbox` 直接用 pi 的 `createLocalBashOperations()`，其 `exec` 支持可选的 `env`（缺省走 pi 的 `getShellEnv()`）。

两套 Bash 工具（`claude-code/shell.ts`、`opencode/bash.ts`）都经 `BwrapRuntime.execute` → `runInSandbox`；配置在加载期由 `createToolRegistration` 读一次（`readToolsConfig`），解析警告已有上报通道（`config.warnings`）。`BwrapRuntime` 的创建点有多个：聚合入口经 `createToolServices`、子代理经 `subagentToolsExtension`、独立入口（`claude-code`/`opencode` 默认导出、`opencode/bash.ts` 默认导出）各自 `createBwrapRuntime`。

## Goals / Non-Goals

**Goals:**

- 注入点只有一处语义（执行层），沙箱与非沙箱路径不会各写一套合并规则。
- 配置读取时机与现有 `personalExtensions` 字段一致：扩展加载期读一次；测试里创建 runtime 不读用户真实 settings.json。

**Non-Goals:**

- 不提供取消/删除 `process.env` 里已有变量（值为字符串，只做 set）。
- 不做按项目/按模型的 env 覆盖（`personalExtensions` 全局一份）。
- 不支持 `bwrap` 网络栈、LSP、gh 等其它子进程的 env 注入。

## Decisions

1. **注入参数沿现有装配链显式传递**：`BwrapRuntime` 构造器新增 env 参数 → `execute()` 放进 `runInSandbox` 的请求 → `buildBwrapInvocation(resolved, workspace, command, env)` / 本地路径包一层 ops 传 `env`。理由：`readToolsConfig()` 在 `createBwrapRuntime` 里做默认值会让所有测试读到开发机 settings.json，污染测试；显式注入让测试与生产都能确定 env 来源。

2. **`shell.env` 合并顺序：基础值在前，配置在后**（用户显式覆盖生效）。替代方案「保护基础键不可覆盖」实现更复杂、也无法解释为何 `HOME` 不能改；配置由用户自己写，覆盖是预期行为，`bash -lc` 之后的 profile 仍可能再改动 `PATH` 等。

3. **非沙箱路径的基底用 `process.env`**：pi 的 `getShellEnv()` 未从包根导出，拿不到它补的 bin 目录。为避免影响未配置 env 的用户，**只在 `shell.env` 非空时**才显式传 env（此时基底 `{...process.env, ...shell.env}`），否则继续用 pi 的默认实现。残余差异仅是「配置了 env 且沙箱关闭」时 PATH 少一个 bin 目录。

4. **配置形状 `shell: { env: Record<string,string> }`**：用独立 `shell` 对象而不是扁平 `shellEnv`，给后续同类配置（如未来的 cwd 默认值）留位置；解析用 typebox schema + 逐键校验，非法键/非字符串值单独告警并跳过，其余键生效（与现有条目级容错一致）。

5. **入口改动面**：`ToolServicesOptions.shellEnv` 由 `src/index.ts` 与 `subagentToolsExtension` 从 `registration.config.shellEnv` 传入；三个独立入口自己 `readToolsConfig().shellEnv` 后传给 `createBwrapRuntime`，保持「入口与独立加载两条路径行为一致」（沿用 tool-registration spec 的既有约定）。

6. **预览自动一致**：`previewSandboxCommand` 与 `execInvocation` 共用 `buildBwrapInvocation`，env 合并放在后者即可，`--print-args` 无需单独处理。

## Risks / Trade-offs

- [配置了 `PATH`/`HOME` 等基础键会改变沙箱行为] → 文档写明覆盖语义；不做特殊屏蔽，保持可解释性。
- [非沙箱路径失去 pi 的 bin 目录] → 仅影响「配置了 `shell.env` 且沙箱关闭」的场景；用 `process.env` 为基底，已包含用户登录 shell 的 PATH。
- [env 在扩展加载期读取] → 与现有 `fileIo`/`disabledTools` 相同：改配置需要新会话或 `/reload`，README 已说明这个时机。
- [测试可能受开发机 `shell.env` 影响] → 所有 runtime 创建点显式传参，`createBwrapRuntime()` 无参时不注入。
