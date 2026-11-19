# Design

## Context

走工具集默认导出的 e2e 测试通过 `createToolRegistration` → `readToolsConfig()` 读真实 `~/.pi/agent/settings.json`（`readTracking` 等 config 值由此而来），并通过 `loadLspConfig` 的默认路径读真实全局 `lsp.json`。`createToolRegistration(pi, settingsPath?)` 与 `LspServiceOptions.globalConfigPath` 两条注入缝都已存在，只是默认导出没有暴露前者、测试没有使用后者。

## Goals / Non-Goals

**Goals:**

- 走默认导出的测试在调用点显式声明配置来源，不依赖、不修改任何进程级状态；本地与 CI（无用户配置）行为一致。
- 保持默认导出对真实注册路径（config 解析 + availability 过滤 + session_start 接线）的覆盖不变。

**Non-Goals:**

- 不用 `PI_CODING_AGENT_DIR` 覆盖做隔离（否决记录见 Decisions）。
- 不引入 vitest 全局 setupFiles 隔离。
- 不改 `createToolRegistration` / `readToolsConfig` 的形态（注入参数已存在）。
- 不动 agent dir 硬编码（属 `unify-agent-dir-config-paths`）。

## Decisions

### 1. 显式注入，而非 env 覆盖

src 改动是「暴露现成的缝」而非新建：两个默认导出形态完全对称（`createToolRegistration(pi)` + `...options` 展开 + config 值覆盖 `readTracking`），各加一行 `settingsPath?: string` 并透传即可；`globalConfigPath` 经 `...options` 直通自建 LspManager → `createLspService`，零 src 改动。

评估过的备选：

- **逐文件 `PI_CODING_AGENT_DIR` 覆盖**（仓库 8 个测试文件的既有惯例，`unify-agent-dir-config-paths` 落地后 env 覆盖也会变完整）：仍是进程级全局状态，隔离意图不在调用点可见，新测试容易漏加；且与「默认导出强制用 config 值覆盖 `readTracking`」的现状叠加时，测试无法在不改 env 的前提下表达「我要默认配置」。不取。
- **vitest setupFiles 全局隔离**：能覆盖未来新增测试，但与现有测试的 env set/delete/restore 恢复逻辑（`aft-logger`、`spawn-agent`、`tool-registration-entry`）存在串扰风险（worker 复用时 delete 掉的变量让后续文件裸奔），且引入与现有文件不同的新机制。
- **测试改用 named export**：丢失对默认导出真实注册路径的覆盖，不取。

### 2. 注入「必然不存在的路径」，沿用既有惯例

`readToolsConfig` 与 `readConfigFile` 对缺失文件都按「未配置」处理，注入的空来源全部落到默认值（`fileIoReadTracking: true` 等）。路径形态沿用 `lsp.ts` noop service 的 `join(tmpdir(), ".pi-lsp-noop-global-does-not-exist.json")`——文件名自带「必然不存在」的语义。

### 3. 隔离范围收敛为「走默认导出且行为受配置影响」的 6 个测试

`tool-registration-entry`、`claude-code-tools`、`spawn-agent` 等 reads 断言测试已自带隔离或显式传 options，不动。`opencode-write` / `opencode-edit` 走 named export（不读全局 `settings.json`），不动。

### 4. `settingsPath` 透传不改变默认导出的 `readTracking` 语义

默认导出维持「config 值优先」：`readTracking` 仍取 `registration.config.fileIoReadTracking`，不改为「显式 options 优先」。注入空 `settingsPath` 后 config 来自已知为空的来源，`readTracking` 自然取默认 true；不额外引入两个来源间的优先级问题。

## Risks / Trade-offs

- [测试注入「必然不存在的路径」依赖「缺失 = 默认配置」这一语义] → `readToolsConfig` / `loadLspConfig` 对缺失文件的容错是既有行为且有测试覆盖（`tools-config` 测试）；文件名带 `does-not-exist` 语义自明。
- [新测试可能再次漏隔离（不走注入就回到读真实配置）] → 与 env 覆盖方案同风险且更低：注入发生在测试自己的调用点，code review 可见；必要时后续可在测试 helper 层收敛。
- [全局 `lsp.json` 注入后，e2e 测试不再合并真实全局配置] → CI 本来就没有用户配置，此改动让本地与 CI 对齐，正是目标；若未来需要「合并真实全局配置」的测试场景，应显式构造而不是依赖开发者本机文件。

## Open Questions

（无）
