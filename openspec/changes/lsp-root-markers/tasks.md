## 1. Schema 与配置校验

- [x] 1.1 `serverConfigSchema` 增 `rootMarkers: Type.Optional(Type.Array(Type.String({ minLength: 1 })))`，`ConfigAdapter` 暴露 `readonly rootMarkers: readonly string[]`（缺省 `[]`）；在 `test/lsp-server-config.test.ts` 补 schema 解析用例（含空串标记被拒绝），`pnpm vitest run test/lsp-server-config.test.ts` 通过
- [x] 1.2 `resolveConfig` 增加互斥校验：同一 server 同时出现 `workingDir` 与 `rootMarkers` 抛 `lsp.json: server "<id>": workingDir and rootMarkers are mutually exclusive`；补单测断言抛错信息，`pnpm vitest run test/lsp-config.test.ts` 通过

## 2. root 解析

- [x] 2.1 `adapter.ts` 的 `serverRoot` 改为 `serverRoot(adapter, file, cwd)`：`rootMarkers` 非空时沿 `dirChain(cwd, dirname(file))` 从 cwd 向下找第一个含标记的目录（`exists(join(dir, marker))`，未命中回退 cwd，不越 cwd），否则维持 `workingDir ?? cwd`；`LspServerAdapter` 接口加 `rootMarkers` 字段；`test/lsp-server-config.test.ts` 的 `serverRoot` 用例覆盖最外层命中 / cwd 命中优先 / 未命中回退 / 越界回退 / workingDir 行为不变
- [x] 2.2 `lsp.ts` 的 `getClients` 改为 `const root = serverRoot(adapter, file, cwd)`，保留 `containsPath(file, root)` 过滤（`workingDir` 语义不变）；集成测试断言子目录文件在各自标记目录启动实例
- [x] 2.3 按用户反馈把搜索方向从"向上取最近"改为"从 cwd 向下取最外层"（tsserver 的 tsconfig 搜索被 LSP root 截断，root 更深会加载不到根配置）；同步更新 proposal / design / spec / skill 文档与 `serverRoot` 用例

## 3. reload 恢复多实例

- [x] 3.1 `respawnRunning` 改收 `{ serverID, root }[]`（按 `root\0serverID` 去重），`reload(serverID)` 与 `reloadAll()` 在清理前从 `state.clients` 捕获运行集合后逐个 `startClient`；补测试断言多 root 服务器 reload 后全部恢复

## 4. 集成测试

- [x] 4.1 `test/lsp-server-config.test.ts` 新增容器 cwd 集成用例：cwd 无标记、两个子项目各含标记文件，同一 server 触碰两边的文件后产生两个实例（mock server 日志 / 诊断分别命中各自 root），`pnpm vitest run test/lsp-server-config.test.ts` 通过
- [x] 4.2 回归：不配置 `rootMarkers` 的既有用例（include / workingDir / 超时 / settings）全部保持通过，`pnpm test` 全绿

## 5. 文档

- [x] 5.1 更新 `src/skills/lsp-config/SKILL.md`：字段表加 `rootMarkers`、`workingDir` 行说明互斥、monorepo 示例、每 root 一个实例的说明，并删掉"未知字段（含已删除的遗留字段如 rootMarkers）"的表述
- [x] 5.2 更新 `openspec/specs/lsp/spec.md` 的 Implementation 段：根定位描述改为 `rootMarkers` / `workingDir` 互斥语义，顺带删除已失效的 per-server `cwd` 模板描述

## 6. 验证与收尾

- [x] 6.1 `pnpm check`、`pnpm lint`、`pnpm test` 全部通过，检查最终 diff 无调试代码与无关改动
- [x] 6.2（可选，需用户确认后执行）给本机 `~/.pi/agent/lsp.json` 的 typescript / pyright / rust-analyzer / go 服务器补 `rootMarkers`，用 `/lsp-reload` 后在含子项目的仓库验证 root 归属
