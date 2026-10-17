# Proposal

## Why

部分语言服务器的可执行文件不是现成的，需要先执行安装/补装命令才能正常工作（典型如 rust-analyzer 要 `rustup component add rust-analyzer`）。而且「binary 能解析到」不等于「可用」：rustup 的 rust-analyzer proxy 在 PATH 里但组件未装时，解析成功、启动照样失败。所以 setup 不能以 binary 缺失为触发条件，必须在启动前无条件执行。目前用户要自己查安装方式、开终端手动执行、再 `/lsp-reload`，流程割裂。

## What Changes

- `servers.<id>` 新增 `setup` 字段（argv 数组，与 `initializationOptionsCommand` 同构）：**每次启动该服务器实例前无条件执行**（无论 binary 是否解析得到，reload 后同样执行），执行完成后解析 `bin` 并继续启动。
- setup 命令 argv 项支持 `{root}` / `{cwd}` 模板与 `${VAR}` 插值；以服务器项目根为 cwd，环境为 process env 叠加已解析的 `env`；stdout 忽略（不要求非空）。
- 失败语义与 `initializationOptionsCommand` 一致：命令 spawn 错误 / 非零退出（**即使 binary 能解析到**），或 setup 成功后 `bin` 仍解析不到，即启动失败并报错（错误信息含具体命令、退出码与 stderr），不启动进程。
- 未配置 `setup` 的服务器行为与现状完全一致。命令应幂等（每次启动都会执行），文档中说明。
- lsp-config skill 文档补充 `setup` 字段说明与 rust-analyzer 示例（`["rustup", "component", "add", "rust-analyzer"]`），不内置任何按语言的 setup 逻辑或命令表。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `lsp`：「服务器启动」需求新增 setup 命令场景（执行时机、命令执行环境、失败语义）。

## Impact

- `src/lib/lsp/server-config.ts`：`serverConfigSchema` 加 `setup` 字段；`ConfigAdapter.spawn` 在 bin 解析前执行 setup；命令执行 helper 支持忽略 stdout。失败经既有启动失败通路上报，`lsp.ts` 无需改动。
- `src/skills/lsp-config/SKILL.md`：`servers.<id>` 字段表加 `setup`，示例补 rust-analyzer。
- 测试：`test/lsp-server-config.test.ts` / `test/lsp-config.test.ts` 补 setup 触发与失败语义用例。
