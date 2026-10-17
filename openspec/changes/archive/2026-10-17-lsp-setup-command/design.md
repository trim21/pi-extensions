# Design

## Context

`ConfigAdapter.spawn`（`src/lib/lsp/server-config.ts`）的流程是：`resolveBinary` → `resolveEnv` → `resolveInitializationOptions` → spawn；`resolveBinary` 返回 undefined 时 spawn 返回 undefined，`lsp.ts` 的 `startClient` 报 "binary not found" 进 broken。`spawn` 抛出的错误经 `startClient` 的 catch 以 `error.message` 作为 cause 上报（`reportStartupFailure`），所以 setup 的失败文案只需在 `server-config.ts` 里抛出即可，`lsp.ts` 不需要改动。

命令执行语义已有先例：`runConfigCommand`（argv 直接执行、`{root}`/`{cwd}` 模板 + `${VAR}` 插值、错误带命令/退出码/stderr），被 `env` 的 `sh` 与 `initializationOptionsCommand` 共用；但它要求 stdout 非空，对 setup 不适用。

## Goals / Non-Goals

**Goals:**

- 每次启动服务器实例前无条件执行 setup（binary 存在与否都执行），执行后解析 `bin` 继续启动。
- 失败信息可定位（命令、退出码、stderr），与既有 `initializationOptionsCommand` 的命令执行语义保持一致。

**Non-Goals:**

- 不内置按语言的 setup 命令表或 builtin（rust-analyzer 只以 lsp-config skill 文档示例形式给出）。
- 不做执行频率控制：不缓存 setup 结果、不做「每会话一次」去重；是否幂等由配置的命令自己保证。
- 不为 setup 引入 shell 解释器包装；需要 shell 特性时配置自行包 `["bash", "-c", "..."]`。

## Decisions

1. **无条件执行，位置在 `ConfigAdapter.spawn` 的 `resolveEnv` 之后、`resolveBinary` 之前**：「binary 能解析到」不等于「可用」（rustup proxy 在 PATH 里但组件未装的场景解析照样成功），所以不能拿解析结果当触发条件。放在 spawn 内部是因为这里是唯一同时持有 env 解析、bin 解析与进程启动的层；`lsp.ts` 侧只有错误字符串，区分不了失败原因。备选（按 bin 缺失触发、在 `lsp.ts` 挂钩子）都因上述原因放弃。
2. **失败即抛错、走既有 broken 通路**：setup spawn 失败 / 非零退出抛 `Error`（文案含命令、退出码、stderr，格式同 `initializationOptionsCommand` 失败），binary 能解析到也不豁免；setup 成功后 `bin` 仍解析不到也抛错（文案说明 setup 已执行）。两者都由 `startClient` 的 catch 报启动失败，`/lsp-reload <id>` 可重试。
3. **命令执行 helper 参数化输出要求**：把 `runConfigCommand` 的核心抽出为共享执行器，setup 变体忽略 stdout、只要求零退出。不做两个平行实现，避免报错格式漂移。
4. **setup 的环境 = process env + 已解析 `env`，配置了 `setup` 时 `resolveEnv` 相应提前**：与 `initializationOptionsCommand` 同构（安装脚本可能读 `env` 里的变量）。配置了 `setup` 的流程：`resolveEnv` → setup → `resolveBinary` → `resolveInitializationOptions` → spawn；未配置 `setup` 保持现状顺序（bin 缺失时 `env` 的 `sh` 命令照旧不执行），满足 spec 的「未配置 setup 时启动行为不变」。
5. **每次 spawn 都执行，不做去重与加锁**：每个 root 实例、每次 reload 都跑一遍；同一服务器多 root 并发启动时可能并发执行同一 setup。备选「每会话每服务器一次」需要额外状态缓存且 reload 后语义模糊，放弃；并发重复执行靠命令幂等（rustup 有内部锁）保证，不做跨实例协调。

## Risks / Trade-offs

- [setup 脚本耗时或有副作用，且每次启动都执行] → 频率语义简单可预测，文档明确要求命令幂等；用户不想要时移除字段即可；broken 状态有冷却期，启动失败不会形成重试风暴。
- [同一服务器多 root 并发执行同一 setup] → 依赖命令幂等与底层工具的锁机制；并发窗口窄（仅同时启动时），不做协调。
- [setup 成功但可执行文件装到了解析范围之外] → 报错明确说明 setup 已执行、bin 仍不可用，由用户修正 `bin` 或安装位置。

## Migration Plan

lsp.json 纯新增字段，未配置 `setup` 的行为与现状一致，无迁移步骤；回滚即移除字段。

## Open Questions

（无）
