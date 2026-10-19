# Tasks

## 1. 扩展实现

- [x] 1.1 新增 `src/request-headers.ts`：用 `ExtensionAPI` 监听 `before_provider_headers`，把 `event.headers["Thread-Id"]` 设为 `ctx.sessionManager.getSessionId()`；函数名与文件语义一致，去掉旧文件里复制残留的 `visionAgent` 命名和注释
- [x] 1.2 在 `package.json` 的 `pi.extensions` 中登记 `src/request-headers.ts`；不加入 `src/index.ts`，不经过工具总线

## 2. 文档同步

- [x] 2.1 `README.md` 扩展概览表新增 `request-headers` 行，并补充说明小节（注入的请求头、独立入口、无工具）
- [x] 2.2 归档时把 `specs/request-headers/spec.md` 同步为 `openspec/specs/request-headers/spec.md`

## 3. 验证

- [x] 3.1 运行 `pnpm check` 与 `pnpm lint`
- [x] 3.2 不新增测试（用户明确要求；扩展只有一次同步赋值）

## Workflow follow-up

- 归档前运行 `openspec validate add-request-headers-extension --strict`。
- 提醒用户在本地删除 `~/.pi/agent/extensions/header-req-id.ts`，避免同一行为被加载两次。
- 归档后更新仓库中已发布的 npm 包说明；修改扩展后需重启 pi agent 才生效。
