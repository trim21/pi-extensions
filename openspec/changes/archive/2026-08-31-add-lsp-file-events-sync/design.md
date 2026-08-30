## Context

现有同步链路只有一个入口：`touchFile` → `client.notify.open()`（`src/lib/lsp/lsp.ts:389`、`src/lib/lsp/client.ts:700`），由 read / edit / write 工具调用。`notify.open` 每次都从磁盘重读文本，未驻留则 `didOpen`（version 0），已驻留则整篇 `didChange`（version + 1）。文档集合 `files` 与 `documentVersions` 只增不减，全模块无 `didClose`。

诊断等待按版本严格匹配：`waitForFreshPush` 忽略 `hit.version !== request.version` 的 push（`src/lib/lsp/client.ts:598`）。pull 侧的 `matched` 与版本无关（`src/lib/lsp/client.ts:413`）。

`client/registerCapability` 只保留 `textDocument/diagnostic` 注册，其他 method 被跳过（`src/lib/lsp/client.ts:289`），因此服务器注册的 watched-files pattern 当前无处存放。

实测记录（本机 `--stdio` 握手，探针脚本，非产品代码）：

- ruff 对从未 `didOpen` 的文件请求 `textDocument/diagnostic` 返回 `{"items":[],"kind":"full"}`，并在 stderr 明确写 `Returning no diagnostics because document ... isn't open`；`didClose` 时推送一条空诊断。→ 证明"不 open 就没有诊断"，也证明关闭时机必须晚于诊断收集。
- pyright 注册 `workspace/didChangeWatchedFiles`：`**/pyrightconfig.json` 与 `**`（`kind: 7`，created|changed|deleted 全类型），并注册 `textDocument/diagnostic`（`interFileDependencies: true`、`workspaceDiagnostics: false`）。→ pyright 把整棵树的监听责任交给客户端。
- ruff 注册 `**/.ruff.toml`、`**/ruff.toml`、`**/pyproject.toml`。
- `fsPromises.watch(dir, { recursive: true })` 在本机 Linux + Node 26 可用，新建子目录内的文件事件能收到；create / delete / rename 都表现为 `rename`，内容改动为 `change`，故 LSP 的 type 必须由 `stat` 判定。
- 现有 `test/lsp-e2e-pyright-ruff.test.ts` 用真实 pyright + ruff 走 cc 工具链，本地 3 passed，可作为本改动的回归基线。

## Goals / Non-Goals

**Goals:**

- 工作区内任意写入者（git、格式化、codegen、并发 agent）造成的变更都能在有限延迟内送达服务器。
- 打开文档的数量与陈旧度有界，服务器对未驻留文件回落到"磁盘即真相"。
- 写后诊断的等待语义不被新链路破坏（不得因 watcher 而空转到超时）。

**Non-Goals:**

- 不追求服务器主动索引从未接触过的项目文件（watcher 只维护已知状态的新鲜度，覆盖率不变）。
- 不做工作区之外的文件跟踪，即使某服务器的 root 高于 `cwd`。
- 不引入文件内容级 diff / 增量同步：整篇重读已是现状，`didChange` 全量或整段替换不变。
- 不实现 `workspace/diagnostic/refresh` 支持（继续声明 `refreshSupport: false`）。

## Decisions

### D1 事件源用 `node:fs/promises` 的 `watch`，不引入 chokidar

`for await (const ev of watch(dir, { recursive: true, signal }))` 一个异步迭代器即可覆盖整个工作区，配合 `AbortController` 做停止。备选 chokidar 会新增依赖且与仓库"FS 一律用 `node:fs/promises`"的约定冲突；备选 mtime 轮询在大仓成本不可控。Linux recursive 已实测可行（见 Context）。

### D2 单个 cwd watcher + client 侧过滤，而非 per-root watcher

watcher 由 `createLspService` 持有，挂在会话 `cwd`，事件 fan-out 给所有存活 client；每个 client 自行按 `root` 前缀、自身扩展名与注册 pattern 过滤。理由：inotify 预算按目录数计，per-root 在 monorepo 里会重复挂载；且工具侧本就有 `containsPath(file, cwd)` 门槛（`src/lib/lsp/lsp.ts:297`），监听范围与可操作范围保持一致。代价是 root 高于 cwd 的服务器收不到 cwd 外的变更——按用户决定接受。

### D3 驻留模型改为有界 LRU，而非"open-forever + 外部改动 resync"

`didOpen` 之后服务器以客户端内容为准，所以对驻留文档而言，外部改动的唯一正确通道是 `didChange`；但这要求持续为每个驻留文档重读+比+发，且撞上 D4 的版本竞态。改为"只让 edit / write 的文档进入有界 LRU、淘汰即 `didClose`"后：驻留集合小（默认 32）、陈旧面有限、外部改动只需一条 `didChangeWatchedFiles`。被否方案：为所有 open 文档做 `resyncFromDisk`（复杂度高，且 read 让集合无界增长）。

### D4 驻留文档被外部改动 → 先 `didClose` 再发事件，绝不 bump 版本

写后等待只认本次写入的版本号（`src/lib/lsp/client.ts:598`）。watcher 若在同一路径 bump 版本，等待方会一直收不到匹配 push 而空转到 `diagnosticsDocumentWaitTimeoutMs`。退场（close）让磁盘成为真相，语义与协议一致，且不需要放宽版本匹配（原方案的"接受更高版本"改动取消）。自身写入的 echo 用"磁盘文本与 `files[path].text` 相同则忽略"消掉，避免每次 Edit 都白白关闭再重开文档。

### D5 `read` 不再让文档长驻

read 频率远高于 edit / write，若也进 LRU 会把真正需要驻留的编辑文件挤出去。read 改为只发一次 `didChangeWatchedFiles`（created / changed）通知服务器"磁盘上有这个文件了"。依据：pyright 注册了 `**`，本就以客户端文件事件驱动非驻留文件的分析；ruff 只对驻留文档产出诊断，read 的 didOpen 对它有收益但对诊断上报链路无收益（我们只报告被编辑文件的诊断）。

### D6 watcher → 通知的批处理参数

尾部去抖 300ms、最长 1s 强制 flush、单批上限 500 条（超出截断并一次性 notify）、内置忽略 `**/node_modules/**`、`**/.git/**`、`**/dist/**`、`**/build/**`、`**/.venv/**`、`**/venv/**`、`**/target/**`、`**/coverage/**`。参数集中在 `src/lib/lsp/watcher.ts`，由 `lsp.json` 覆盖。目录事件默认丢弃（服务器按 pattern 自行 glob）；仅当目录被删除/移出时，对其内部的驻留文档补 `deleted` 事件——驻留集合有界，这个补算成本可控。

### D7 配置落点

`lsp.json` 顶层新增 `watch?: { enabled?: boolean（缺省 true）, debounceMs?, maxBatch?, ignore?: string[] }` 与 `maxOpenDocuments?: number`（缺省 32），沿用现有 typebox schema + `timeoutValue` 字符串时长写法；per-server 不做 override（避免为假想需求开门）。`LspServerAdapter` 接口不新增字段，watch 是 client 层之上的工作区能力，与服务器定义正交。

## Risks / Trade-offs

- [大仓 recursive watch 触发 `ENOSPC`（inotify 上限）或明显 CPU/IO 抖动] → watcher 启动失败与运行期 error 一律降级：停掉 watcher、一次性 `ctx.ui.notify` 提示、诊断链路保持今日行为；提供 `watch.enabled: false` 全局关断。
- [事件洪峰（`pnpm install`、分支切换）超上限被截断，服务器状态残留不一致] → 截断时 notify 提示可用 `/lsp-reload <id>` 强制重建；不假装"已同步"。
- [vtsls / tsserver 在 `didClose` 后是否按 `didChangeWatchedFiles` 重读磁盘] → 已用本仓库真实客户端（`src/lib/lsp/client.ts`）跑 stdio 生命周期探针验证：vtsls 对 open 文档 `didClose` 后，外部改写其依赖文件并发送 `didChangeWatchedFiles`，再次 `didOpen` 时诊断反映新磁盘内容（依赖错误随磁盘修复而消失），D4 无需退化路径。pyright 实测：驻留期间外部改写被依赖文件 + `didChangeWatchedFiles` → 产品 pull 路径（`waitForDiagnostics`）返回反映新磁盘状态的诊断；对从未 `didOpen` 的文件 pull `textDocument/diagnostic` 返回空（`kind: full`），即"诊断请求要求文档驻留"成立，跨文件依赖在未驻留时通过文件事件 + 编辑时重新 `didOpen` 刷新。
- [`didClose` 后服务器推送空诊断抹掉缓存（ruff 实测如此）] → 关闭一律发生在诊断汇总之后；淘汰只作用于非当前等待路径（刚 touch 的文档是 MRU，天然不会被自己挤掉）。
- [去掉 read 的 didOpen 可能让某些服务器少一次 eager 索引] → 保留回退：若 e2e 显示跨文件诊断退化，改为 read 走"open→立即 close"的一次性对，仍不占驻留名额。
- [echo 判定要 `readFile`，与并发写入交叠时可能读到中间态] → 只在驻留文档上发生，且最坏结果是多余一次退场+重开（自愈），不会产生错误诊断。

## Migration Plan

一次性落地（watcher 与 LRU 是同一行为契约的两半，拆开会留下"外部改动既不 resync 也不退场"的空窗）。默认 `watch.enabled: true`。回滚：配置 `watch.enabled: false` 即回到仅工具触发的现状；LRU 部分通过把 `maxOpenDocuments` 配大退化为接近今日行为（无需回滚代码）。实施顺序与验证见 `tasks.md`。

## Open Questions

- 默认容量 32 是否合适：等 e2e 与真实会话跑一段时间后按"淘汰后立刻被重新编辑"的频率调，不影响规格与任务拆分。
- 是否在 Bash 工具结束后额外立即 flush 一次去抖窗口（当前设计只靠 watcher 自身的 300ms 去抖）：属于体验微调，可在实施后按体感决定。
