## 1. 前置验证（决定 D4 是否需要退化路径）

- [x] 1.1 用本仓库真实客户端跑 vtsls 生命周期探针：`didOpen` → 收诊断 → `didClose` → 外部改写磁盘 + `didChangeWatchedFiles` → 观察诊断是否随之更新；把结论写进 `design.md` 的 Risks（若 vtsls 不认关闭后的 watchedFiles，则停下与本 change 所有者确认 D4 退化方案，不继续实现）
- [x] 1.2 用同样方法验证 pyright 的"关闭后靠 watchedFiles 回落磁盘"行为（本机 `pyright-langserver` 可用），确认跨文件依赖（`interFileDependencies: true`）在未驻留时仍能刷新
- [x] 1.3 记录两个服务器在未 `didOpen` 时的 pull 结果（ruff 已实测返回空 + stderr 警告），作为"诊断请求要求文档驻留"这条 scenario 的可验证依据

## 2. Watcher 本体

- [x] 2.1 新建 `src/lib/lsp/watcher.ts`：`node:fs/promises` 递归 watch 工作区目录 + `AbortController` 停止 + 尾部去抖（缺省 300ms、最长 1s flush）+ `stat` 判定 created/changed/deleted + 内置忽略列表 + 单批上限 500（超限截断并回调提示一次）+ error 降级回调；验证方式：新增 `test/lsp-watcher.test.ts` 覆盖创建/修改/删除三类映射、新建子目录内文件可见、去抖合并成单批、`node_modules`/`.git` 被忽略、超限截断只提示一次、`stop()` 后不再回调
- [x] 2.2 在 `src/lib/lsp/lsp.ts` 的 `lspConfigSchema` 增加 `watch: { enabled, debounceMs, maxBatch, ignore }` 与 `maxOpenDocuments`（缺省 `enabled: true` / `32`），沿用 `timeoutValue` 字符串时长写法；验证方式：`test/lsp-config.test.ts` 新增用例断言缺省值、字符串时长换算、非法值被 typebox 拒绝

## 3. Client 侧协议

- [x] 3.1 扩展 `test/fixtures/mock-lsp-server.mjs`：把收到的 notifications 以 JSONL 回传供断言，并支持服务器主动发 `client/registerCapability`；验证方式：现有 `test/lsp-client.test.ts` 与 `pnpm test` 全绿（改造不改变既有行为）
- [x] 3.2 `client.ts` 增加 `FILE_CHANGE_DELETED = 3` 与 `notify.watchedFiles(changes)`：驻留文档一律排除，非驻留路径合并成一条 `workspace/didChangeWatchedFiles`；验证方式：`test/lsp-client.test.ts` 断言载荷结构、批量合并为单条、驻留路径不出现在 watchedFiles 里
- [x] 3.3 `client/registerCapability` / `client/unregisterCapability` 记录并移除 `workspace/didChangeWatchedFiles` 的 watchers glob，按 registration id 幂等去重，并经 `watchPatterns()` 暴露给 service 过滤；验证方式：单测断言两次注册同一 pattern 只保留一份、unregister 后不再匹配
- [x] 3.4 实现驻留 LRU：仅 edit / write 触发的文档进入（进入 `didOpen`、已驻留 `didChange`），超过 `maxOpenDocuments` 时对最久未使用者 `didClose` 并移出 `files` / `documentVersions`；验证方式：单测断言容量 N+1 时最早驻留者收到 `didClose`、被淘汰文件再次 edit 时重新 `didOpen`（version 归 0）
- [x] 3.5 实现"驻留文档外部改动退场"：先 `didClose` 再发 changed 事件；磁盘内容与 `files[path].text` 相同时完全不发消息；验证方式：单测断言同内容 echo 零通知、外部改写产生一条 `didClose` + 一条 changed watchedFiles，且 `waitForFreshPush` 的版本匹配逻辑未被放宽（`client.ts:598` 仍严格相等）

## 4. Service 接线

- [x] 4.1 `createLspService` 持有单个 cwd watcher：首个 client 建立时启动、`closeAll` / `reload` / `stop` 且无存活 client 时停止、会话 cwd 变化时重建；事件 fan-out 给各 client 并按其 root 前缀 + `watchPatterns()` + 扩展名过滤；验证方式：注入 fake watcher 的单测断言启停时机与过滤结果（cwd 外路径不转发）
- [x] 4.2 `read` 不再让文档长驻：改 `src/claude-code/files.ts` 与 `src/opencode/files.ts` 的 warm-up 调用为只发文件事件通知；验证方式：两套工具集现有测试 + `test/lsp-e2e-pyright-ruff.test.ts` 保持全绿，并新增断言"read 之后该路径不在驻留集合"
- [x] 4.3 保证 `didClose` 一律晚于诊断收集（ruff 实测在 close 时推空诊断）：淘汰与退场路径跳过当前等待中的文档；验证方式：新增 e2e 用例——连续 edit 超过 `maxOpenDocuments` 个文件后，每个 Edit 返回文本仍包含其自身诊断

## 5. 回归与交付

- [x] 5.1 新增跨文件回归 e2e：外部工具改写被依赖文件 + `didChangeWatchedFiles` 后，对上层文件的 Edit 诊断反映新状态（用真实 pyright，二进制缺失时按现有约定整组跳过）；验证方式：该用例在实现前失败、实现后通过
- [x] 5.2 运行 `pnpm test`、`pnpm check`、`pnpm lint` 全绿；验证方式：三条命令退出码为 0
- [x] 5.3 更新 README 的 lsp 配置示例（`watch` / `maxOpenDocuments`）与 `openspec/specs/lsp/spec.md` 归档同步；验证方式：`openspec validate add-lsp-file-events-sync --strict` 通过，README 示例字段与 schema 一致
