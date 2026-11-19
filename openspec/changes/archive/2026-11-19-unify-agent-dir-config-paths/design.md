# Design

## Context

pi 的 `getAgentDir()`（`@earendil-works/pi-coding-agent`）是 agent dir 的唯一解析入口：优先 `PI_CODING_AGENT_DIR`，缺省 `~/.pi/agent`。仓库中 `tools-config.ts`、`bwrap/*`、`talk`、`spawn-agent` 等已经统一走它；剩 6 处直接 `join(homedir(), ".pi", "agent", ...)` 的硬编码（见 proposal）是漏网。

## Goals / Non-Goals

**Goals:**

- agent dir 下所有用户配置的读取统一经 `getAgentDir()` 解析，`PI_CODING_AGENT_DIR` 一处生效。

**Non-Goals:**

- 不改变任何配置文件的缺省位置（未设 env 时路径与现状相同）。
- 不动 `src/web/config.ts` 的 `.pi/web-search.json`（不在 agent dir 下，是另一个位置约定）。
- 不解决「测试读真实用户配置」的问题——那是独立 change `test-config-injection` 的范围。

## Decisions

### 路径解析统一用 `getAgentDir()`，不新增本地抽象

6 处改动各为一两行：`join(homedir(), ".pi", "agent", X)` → `join(getAgentDir(), X)`，从 `@earendil-works/pi-coding-agent` 导入（`tools-config.ts`、`talk/index.ts` 已有同样的导入先例）。不抽 `agentFilePath()` 之类的本地 helper——6 个调用点分属 5 个模块，抽公共函数要新建一个被所有人依赖的 lib 模块，收益只有少写一个参数。

`lsp.ts` 有两处（`loadLspConfig` 的默认参数 `lsp.ts:349` 与 `createLspService` 的回退 `lsp.ts:577`），都改；两处形态一致，避免「默认路径走 env、回退路径不走」的不对称。

## Risks / Trade-offs

- [设置过 `PI_CODING_AGENT_DIR` 的非测试环境（如用户自定义脚本）里这些配置的读取位置会变] → 该环境变量本就是 pi 官方的重定向语义，此前行为属于 bug；未设 env 的环境零变化。
- [全局 `lsp.json` 改经 agent dir 后，依赖「设 env 但 lsp 读真实 home」这种意外行为的用法会受影响] → 未发现仓库内或测试内的此类依赖；如有外部用法，正确做法也是改用 agent dir 下的配置。

## Open Questions

（无）
