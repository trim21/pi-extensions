## Why

LSP 诊断目前只反映"本 agent 亲手碰过的文件"的快照：唯一的同步入口是 read / edit / write 调用的 `touchFile`。服务器对 `git checkout`、外部格式化、codegen、以及 talk 多 agent 并发写同一工作区的变更一无所知，跨文件诊断会基于过期内容，且没有任何通道让它自愈。

同时我们在 initialize 里声明了 `workspace.didChangeWatchedFiles.dynamicRegistration: true`，服务器也确实据此把监听责任交给我们——实测（本机 pyright / ruff，`--stdio` LSP 握手）：

- pyright 注册 `workspace/didChangeWatchedFiles`，patterns 为 `**/pyrightconfig.json` 与 `**`（整棵树，`kind: 7` = created|changed|deleted 全类型）；
- ruff 注册 `**/.ruff.toml`、`**/ruff.toml`、`**/pyproject.toml`。

但 `client/registerCapability` 只处理 `textDocument/diagnostic`，其余注册请求被 ack 后直接丢弃。也就是说：协议层面我们承诺了会通知，实际从不通知，服务器据此关掉了自己的兜底监听。

反面问题同样存在：文档只 open 不 close。`client.ts` 的 `files` 映射只增不减，全仓库无 `didClose`。一次 session 里 `read` 过的每个文件都变成长驻的"编辑器 buffer"，服务器以我们的内存快照为准（不重读磁盘），陈旧度与驻留量随会话单调增长——这也是为什么单纯加 watcher 会撞上"必须给 open 文档补 didChange、进而与写后诊断的版本等待抢版本"的复杂度。

## What Changes

- 新增**单个工作区文件监听器**：挂在 session `cwd` 上（recursive），只跟踪工作区内路径，工作区之外的事件不处理；create / change / delete 按 LSP `workspace/didChangeWatchedFiles` **批量**转发给存活的服务器，带 `FILE_CHANGE_DELETED`（当前只发 1、2 两种）。
- **兑现动态注册**：记录服务器注册的 `watchers` glob（含 `unregisterCapability`），按各服务器的 pattern 与扩展名过滤后再投递；不再有 ack 即丢弃。
- **文档驻留改为有界 LRU**：只有 edit / write 产出的文档进入 LRU，进入时 `didOpen`（已在驻留集合内则 `didChange`），淘汰时 `didClose`。`read` 的 warm-up 不再让文档长驻。
- **外部改动落在驻留文档上时走"退场 + 通知"**：先 `didClose` 再发 `didChangeWatchedFiles`，让服务器回落到读磁盘；避免与"写入→等版本匹配诊断"的等待窗口竞争。我们自身写入产生的 echo 由内容比对消掉。
- **配置面扩展**（`lsp.json`，typebox schema）：监听开关、去抖时长、忽略 glob、驻留容量。
- didClose 时机收紧为"该文档诊断已收集完毕之后"：实测 ruff 在 `didClose` 时会推一条空诊断，先收后关才不会抹掉本次写作的诊断结果。

## Capabilities

### Modified Capabilities

- `lsp`：新增两条 Requirement——工作区文件事件同步（watcher + 动态注册 pattern + 批量转发与类型映射）、文档驻留与失效（LRU 有界集合、didClose 时机、外部改动退场）。现有"写后诊断"Requirement 的等待语义随驻留模型改变而需补充约束。

## Impact

- 代码：`src/lib/lsp/watcher.ts`（新增）、`src/lib/lsp/client.ts`（`FILE_CHANGE_DELETED`、`notify.watchedFiles`、LRU 与 didClose、注册 pattern 记录）、`src/lib/lsp/lsp.ts`（watcher 生命周期、配置 schema）、`src/lib/lsp/adapter.ts` / `server-config.ts`（配置透传）。
- 测试：新增 `test/lsp-watcher.test.ts`；扩展 `test/lsp-client.test.ts`（当前对 `didChangeWatchedFiles` 载荷零断言）与 `test/lsp-e2e-pyright-ruff.test.ts`（本地实测 3 passed，可作为回归基线）。
- 依赖：无新增运行时依赖。事件源用 `node:fs/promises` 的 `watch`（recursive，Linux 实测可用），glob 用已有的 `minimatch`。
- 风险与待验证：`fs.inotify.max_user_watches` 上限与大仓事件洪峰（需忽略规则、去抖、批量上限与降级）；vtsls / tsserver 在文档 close 后是否按 `didChangeWatchedFiles` 重读磁盘尚未实测（独立探针未跑通，需用本仓库真实客户端验证）。
