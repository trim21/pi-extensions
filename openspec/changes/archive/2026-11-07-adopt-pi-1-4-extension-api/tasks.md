# Tasks

## 1. 依赖声明

- [x] 1.1 `package.json` 里三个 `@earendil-works/pi-*` 的 peer 改为 `^1.4.0`、dev 改为精确 `1.4.0`；验证：`pnpm install` 后 `node -e "console.log(require('./node_modules/@earendil-works/pi-coding-agent/package.json').version)"` 为 `1.4.0`

## 2. 适配 pi 1.4 的扩展 API

- [x] 2.1 `src/session-name.ts` 的 `before_agent_start` 处理先按 `messageType !== "user"` 早退再读 `event.prompt`；验证：`pnpm run check` 通过（此前报 `Property 'prompt' does not exist on type 'BeforeAgentStartCustomEvent'`）
- [x] 2.2 `test/session-name.test.ts` 的事件夹具补上 `messageType: "user"`，并新增「custom message 触发的 run 不命名」用例；验证：`pnpm vitest run test/session-name.test.ts` 通过且去掉早退时新用例失败

## 3. 升级策略

- [x] 3.1 `.github/renovate.json`：三个 pi 包成组、只更新 devDependencies、`separateMinorPatch`、打 `ci:manual-merge`；验证：`packageRules` 中 peer 规则 `enabled: false`、dev 规则含 `groupSlug` 与 `separateMinorPatch`
- [x] 3.2 `.github/mergify.yml`：automatic merge 规则加 `label!=ci:manual-merge`；验证：规则条件里该行存在且 `check-success=all-checks` 保留

## 4. 全量验证

- [x] 4.1 `pnpm run lint`、`pnpm run check`、`pnpm test` 全部通过

## Workflow follow-up

- 实现完成并验证通过后，用 `openspec-archive-change` 归档本 change，把 delta 合入 `openspec/specs/session-name/spec.md`
