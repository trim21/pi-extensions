# Proposal

## Why

仓库里 6 处代码用 `join(homedir(), ".pi", "agent", ...)` 硬编码读用户配置，绕过了 pi 的 `getAgentDir()`（`PI_CODING_AGENT_DIR` 环境变量的官方重定向点，优先读 env、缺省 `~/.pi/agent`）。后果是 env 重定向对 agent dir 不完整：设置 `PI_CODING_AGENT_DIR` 的环境（测试、并行会话、容器、自定义脚本）里，这些配置仍然从真实 home 读取，最明显的是全局 `lsp.json`。

## What Changes

- 6 处硬编码改为 `getAgentDir()`，未设置 `PI_CODING_AGENT_DIR` 时行为完全不变（`getAgentDir()` 缺省即 `~/.pi/agent`）：
  - `src/lib/lsp/lsp.ts:349`、`lsp.ts:577`（全局 `lsp.json` 默认路径与回退）
  - `src/session-name.ts:38`、`src/vision-agent.ts:39`（`settings.json`）
  - `src/lib/proxy.ts:41`（`proxy.json`）
  - `src/openai-cost/config.ts:58`（`openai-cost.json`）
- `src/web/config.ts` 的 `.pi/web-search.json` 不在 agent dir 下，属另一个位置约定，不在本次范围。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `lsp`: 「服务器配置」requirement 的全局配置来源从固定 `~/.pi/agent/lsp.json` 改为「agent dir（`getAgentDir()` 解析，`PI_CODING_AGENT_DIR` 可重定向；缺省 `~/.pi/agent/lsp.json`）」，并补一个 env 重定向场景。
- 其余改动（session-name / vision-agent / proxy / openai-cost 的路径解析）只影响实现细节：`session-name` spec 对 settings.json 路径的描述位于 Implementation 段而非 requirement，vision-agent / proxy / openai-cost 无路径相关 requirement，均不需要 delta。

## Impact

- 代码：`src/lib/lsp/lsp.ts`、`src/session-name.ts`、`src/vision-agent.ts`、`src/lib/proxy.ts`、`src/openai-cost/config.ts`（各 1-2 行路径解析）。
- 兼容性：普通用户零变化（不设 env 时路径与现状相同）；设置 `PI_CODING_AGENT_DIR` 的环境下路径解析修正为统一走 agent dir。
- 无依赖 / API 变化（`getAgentDir` 已由 `@earendil-works/pi-coding-agent` 提供，多个模块已在用）。

（测试与本机用户配置的耦合是另一个独立 change：`test-config-injection`，与本 change 无实现依赖。）
