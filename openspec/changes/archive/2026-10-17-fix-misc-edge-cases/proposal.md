# Proposal

## Why

四处边缘行为与 spec 不一致：

1. `vision-agent` 只在 `model` 缺失时不注册；`provider` 缺失（且没有 defaultProvider）时仍注册一个执行必然失败的 `describe_image`。
2. `session-name` 恢复会话时取第一条任意 message，不校验 `role`，可能拿 assistant 的回复当命名依据。
3. `web_fetch` 的 30 秒超时在重定向循环内每跳重新计时，整次抓取可远超 30 秒。
4. `codemode` 把空 active 列表当成「取不到列表」，`--tools` 排除全部工具时反而放开了所有工具；描述里还固定提 `Bash`，opencode 工具集下指向不存在的工具。

## What Changes

- vision：`provider` 与 `model` 都配置才注册。
- session-name：只取 `role === "user"` 的消息。
- web_fetch：30 秒预算在 `fetchWithRedirects` 入口创建一次，覆盖所有重定向跳。
- codemode：空 active 列表返回空集合（求交后无可调用工具）；描述改为不点名具体工具。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无，四处都是让实现回到既有 spec）

## Impact

- 代码：`src/vision-agent.ts`、`src/session-name.ts`、`src/web/fetch.ts`、`src/codemode/tool.ts`。
- 测试：`test/vision-agent.test.ts`、`test/session-name.test.ts`、`test/codemode-tool.test.ts`。
