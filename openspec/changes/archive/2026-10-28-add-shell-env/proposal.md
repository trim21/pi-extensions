# Proposal

## Why

Bash 工具的命令环境是固定的：沙箱路径只注入 `HOME` / `SHELL` / `TERM` / `LANG` / `PATH` 五项常量，用户没有任何办法声明额外环境变量。结果是模型跑 `git rebase -i` / `git commit` 这类会拉起编辑器的命令时会被阻塞（编辑器起不来或等到超时），只能在命令行里逐个临时 `GIT_EDITOR=true git ...` 绕过，既啰嗦又容易被模型忘记。

## What Changes

- `personalExtensions` 新增可选 section `shell.env`：一个 `环境变量名 -> 值` 的映射，作为 bash 工具的额外环境变量注入。
- 注入对 Bash 工具的两条执行路径同时生效：bwrap 沙箱内执行的命令，以及不经沙箱的本地执行（Windows / 审批通过的全权限 / fs 与 network 都是 `allow-all`）。配置项覆盖沙箱默认的那几个环境变量（用户显式写 `PATH` / `HOME` 就按用户的来）。
- 配置非法时（`shell` 不是对象、`env` 不是对象、值不是字符串）按现有风格产生 warning 并忽略该条，其余配置照常生效。
- 独立入口（`claude-code` / `opencode` 的默认导出、spawn-agent 子代理）与聚合入口行为一致。
- 其它会 spawn 子进程的工具（LSP、gh、codemode 脚本）不受影响。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `tool-registration`: `personalExtensions` 增加 `shell.env` 配置项及其解析/校验/警告规则。
- `bwrap`: 新增「命令执行环境」要求——bash 命令的环境由基础默认值加 `shell.env` 注入构成，沙箱与非沙箱两条路径行为一致。

## Impact

- 代码：`src/lib/tools-config.ts`（解析）、`src/lib/tool-services.ts`、`src/index.ts`、`src/spawn-agent.ts`、`src/claude-code/index.ts`、`src/opencode/index.ts`、`src/opencode/bash.ts`（注入点）、`src/bwrap/runtime.ts`、`src/bwrap/sandbox.ts`、`src/bwrap/exec.ts`（执行层）。
- 配置：`~/.pi/agent/settings.json` 的 `personalExtensions`（向后兼容，缺省不注入任何变量）。
- 文档：README 的「工具启用配置」示例。
- 行为风险：`shell.env` 可以覆盖沙箱默认的 `PATH` / `HOME` / `LANG` 等；不经沙箱的本地执行路径不再走 pi 的 `getShellEnv()`（该函数未从包里导出），只在用户配置了 `shell.env` 且沙箱关闭时以 `process.env` 为基底。
