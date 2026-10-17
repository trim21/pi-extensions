# Tasks

## 1. setup 命令执行（src/lib/lsp/server-config.ts）

- [x] 1.1 `serverConfigSchema` 新增 `setup` 字段（argv 数组，`minItems: 1`，语义同 `initializationOptionsCommand` 的 argv：`{root}`/`{cwd}` 模板 + `${VAR}` 插值）；在 `test/lsp-server-config.test.ts` 补 schema 用例：合法数组接受、空数组与非数组拒绝
- [x] 1.2 把 `runConfigCommand` 的执行核心抽出为共享执行器，新增忽略 stdout、仅要求零退出的 setup 变体（报错文案含命令、退出码、stderr，格式与既有命令失败一致）；在 `test/lsp-server-config.test.ts` 补用例：零退出 + 空 stdout 成功、非零退出报错含 stderr、spawn 失败报错含命令
- [x] 1.3 `ConfigAdapter.spawn` 接线：配置了 `setup` 时每次 spawn 在 `resolveEnv` 之后、`resolveBinary` 之前无条件执行；setup 失败抛错（binary 能解析到也不豁免），setup 成功后 `bin` 仍解析不到时抛错（文案说明 setup 已执行）；未配 `setup` 的路径保持现状；在 `test/lsp-server-config.test.ts` 补用例：binary 存在时也执行、执行后用新装的 binary 启动、失败语义与报错文案

## 2. 文档（src/skills/lsp-config/SKILL.md）

- [x] 2.1 `servers.<id>` 字段表补 `setup` 行（每次启动前无条件执行、argv 语义、失败语义、stdout 忽略、命令须幂等），并在 rust-analyzer 示例里给出 `"setup": ["rustup", "component", "add", "rust-analyzer"]`；验证：文档描述与 schema 行为一致，示例 JSON 可被解析

## 3. 整体验证

- [x] 3.1 运行 `pnpm test`、`pnpm check`、`pnpm lint`，全部通过；检查最终 diff 无调试代码或无关变更

## Workflow follow-up

- 用户认可后用 `openspec-archive-change` 归档本变更（同步 spec delta 到 `openspec/specs/lsp/spec.md`）。
