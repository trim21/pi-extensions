# AGENTS.md — pi-extensions

pi-extensions 是 pi coding-agent 的自定义扩展集合，TypeScript ESM 项目，包管理用 pnpm。

## 开发约定

- 包管理与脚本一律使用 `pnpm`（`pnpm install`、`pnpm test`、`pnpm lint`、`pnpm check`），不要使用 `npm` / `npx`。
- 不使用 emoji，除非用户明确要求。代码、注释、UI 文案和回复中都不添加 emoji。
- 代码风格由 Prettier 管理，提交前运行 `pnpm check`（`tsc --noEmit` + `prettier --check`）与 `pnpm lint`。
- 测试使用 Vitest，新增功能需补充对应测试，运行 `pnpm test` 验证。

## 项目结构

```
src/
├── bwrap/        # bubblewrap 沙箱执行层（被 claude-code / opencode 的 Bash 工具复用）
├── claude-code/  # Claude Code 风格工具集（index.ts 为扩展入口）
├── opencode/     # opencode 风格工具集（index.ts 为扩展入口）
├── lib/          # 跨扩展共享工具
├── talk/         # agent 间通信
└── *.ts          # 单文件扩展（gh-readonly、session-name、spawn-agent、vision-agent 等）
test/             # Vitest 测试，文件与 src 对应
bin/              # 辅助脚本（如 gen_seccomp.py）
```

- `claude-code` 与 `opencode` 是两套平行的工具集，由用户在 pi 配置里选择**启用其中一个**，不会同时启用；两者在行为、命名上的差异与冲突是符合预期的，不要试图统一。
- 扩展没有单一根入口，各目录的 `index.ts` 作为扩展入口被 pi 加载；`src/bwrap/` 不单独注册。
