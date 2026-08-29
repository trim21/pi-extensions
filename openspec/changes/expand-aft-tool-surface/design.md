## Context

本仓库的 aft 工具全部是 `@cortexkit/aft-bridge` 的薄封装：JS 侧只负责参数校验、路径解析与写保护审批，把请求以 agent 工具名（`refactor` / `import` / `callgraph` / `search`）经 `bridge.toolCall` 转给常驻 Rust 进程（`src/aft/bridge.ts`）。

分工前提与普通 aft 插件不同：**模型只负责改文件，恢复与 OS 级文件操作由人通过 git 完成**。aft 引擎自带的 `safety`（undo / history / checkpoint / restore / list）、`delete`（本质是"带备份的 rm"，与 AST 无关）、`move`（OS 层文件移动）因此都不属于模型工具面。上游官方 pi-plugin 用 surface tier 表达类似的分级（`packages/pi-plugin/README.md`：`minimal` = outline / zoom / safety，`recommended` 加读写与 import，`all` 才含 callgraph / delete / move / refactor），我们既不引入 tier 配置，就直接不注册需要显式开启才出现的那些面。

embedding 后端的现实约束：aft 的 `semantic.backend` 三选一——`fastembed`（默认，本地 ONNX Runtime）、`openai_compatible`（任意 `/v1/embeddings`）、`ollama`。内网镜像不提供 ONNX Runtime，所以要用 `aft_search` 就必须走外部后端。aft 的取值方式是"配置里给变量名，运行时自己 `env::var`"（`crates/aft/src/semantic_index.rs:931-936`：`api_key_env` 缺省即无鉴权，配了却读不到会直接报 missing），而子进程环境 = 继承的 `process.env` 叠加 `childEnv`（`@cortexkit/aft-bridge` 的 `BridgeOptions.childEnv` 文档明确 "applied on top of the inherited process.env"）。

callgraph 未就绪同样来自引擎侧设计：查询等待窗口由 `AFT_CALLGRAPH_BUILD_WAIT_MS` 决定，生产默认 `0`，即冷构建与 watcher 重建一律立即返回 `callgraph_building`（`crates/aft/src/context.rs:2037`、`context.rs:4257-4296`）。窗口非零时查询会在窗口内 `recv_timeout` 加入同一个 single-flight 构建，就绪后直接返回真实结果——包括 force rebuild（corpus drift / watcher overflow）路径。

版本差异：上游源码仓库是 0.54.0，我们锁 0.53.0。两者对 `inspect` 的描述不同（0.53 schema 自称 "Blocking-fresh" 且没有 0.54 的 `pending_categories` / `stale_categories` 字段），这正是不接 `aft_inspect` 的依据之一。

约束：aft-bridge 的 transport 超时表给 `callgraph` 与 `search` 60 秒（`@cortexkit/aft-bridge/dist/command-timeouts.js`），等待窗口必须明显小于该预算，否则客户端先超时并升级为 kill bridge（aft-bridge 注释里 issue #117 的成因）。

## Goals / Non-Goals

**Goals:**

- 把 callgraph 的"未就绪"从模型可见的无效答复变成引擎侧一次性等待，JS 侧不引入自有轮询循环。
- 让 `aft_search` 在内网可用：只走外部 embedding 后端，密钥由用户在配置文件里给值、扩展负责送达子进程。
- 让 aft 的 prompt 与注释只描述真实存在的模型工具面与模型用得上的事实：消除 `aft_move` / `ast_edit` 悬空引用，去掉可被读成"模型能自助回退"的措辞，不再把其它工具的指引指向条件注册的 `aft_search`。
- 把"不暴露回滚与 OS 级文件操作"固化为 aft capability 的需求，并配可执行护栏。

**Non-Goals:**

- 不接入 `aft_move`、`aft_delete`、`aft_safety`、`aft_inspect`、`conflicts`，也不暴露 `aft_import` 的 `organize` op。
- 不支持本地 ONNX（fastembed）路径，也不负责安装或引导 ONNX Runtime。
- 不引入 surface tier 或 per-tool 配置开关，不改 `write-guard` 审批策略。
- 不改动 `src/lib/lsp/`，不把编辑后诊断迁移到 aft 的内置 LSP 层。

## Decisions

**1. callgraph 等待用引擎窗口，不用 JS 轮询。**
在 `createAftPool` 的 `poolOptions.childEnv` 里追加 `AFT_CALLGRAPH_BUILD_WAIT_MS`，值取自导出常量 `CALLGRAPH_BUILD_WAIT_MS = 30_000`：约为 callgraph transport 预算 60s 的一半，留出查询本身的执行时间。
_备选_：JS 层对 `callgraph_building` 做指数退避重试——否决，每次重试都会重新进入 `callgraph_store_for_ops`，与引擎的 single-flight 构建竞争且重复整趟查询，等待时长不可控；用 `options.timeoutMs` 拉高 transport 超时——否决，会与 aft-bridge 的超时表漂移，正是该表要防的问题。

**2. 恢复与 OS 级文件操作一律不进模型工具表。**
`safety` 的五个 op 全是回滚语义；`delete` 与 `move` 只搬/删路径，与 AST 无关，且 `delete` 的唯一增量（引擎备份）正是我们不提供的那一面。文件级操作继续走 `Bash`：git 跟踪文件用 `git mv` / `git rm`，顺带让改动进入 review 与历史。
_备选_：接入但用 config 默认关掉——否决，多一处配置面和一个模型永远不该看见的能力面，收益为零。

**3. prompt 里不写"不提供撤销"，只写模型用得上的事实。**
"引擎会保存快照""本工具不提供撤销""回退由用户用 git 完成"这类句子都在向模型引入一个它没有的能力面概念——一旦写出"快照"，模型就会去猜怎么用。因此措辞策略是**沉默**：`aft_refactor` 的说明只讲它做什么、参数怎么填，不提回滚，也不提不存在的 `aft_move`。同理 `search.md` 与 `aft_search` 的 description 删掉"需要怎么配置才会注册"——guidelines 只在工具已注册时才注入，这类说明对模型没有意义。

**4. `aft_search` 的注册门控看外部后端，不由 flag 单独成立。**
`semantic_search: true` 只表达"想要语义搜索"，真正能不能用取决于 `semantic.backend` 是否为外部后端且 `semantic.base_url` 非空。不满足时不注册并 notify 原因，避免"开了开关却没有工具"的静默落差。`fastembed` 明确排除。

**5. 密钥注入：值来自配置，变量名默认由扩展固定。**
aft 只认"变量名"，所以我们做两件事：`childEnv[名字] = 值`，以及在用户没给名字时追加一份用户级 config tier（`inlineUserConfigTier({ semantic: { api_key_env: SEMANTIC_API_KEY_ENV } })`）告诉 aft 该读哪个变量。固定名 `AFT_SEMANTIC_API_KEY` 是扩展内部约定，用户不需要知道；显式配了 `api_key_env` 时以它为准且不追加 tier；两者都不配即无鉴权。追加的 tier 排在 `readConfigTiers` 之后——aft 按文档顺序逐份 apply，后到的 `Some(value)` 覆盖先到的（`config_resolve.rs:1475-1477`），所以我们的注入优先于磁盘上的同名配置。
_备选_：要求用户自己 export 变量——否决，比"配置里给 token"多一步且易漏；把密钥值写进 config tier 传给引擎——否决，aft 的契约是只接受变量名，且会把密钥带进配置诊断路径。

**6. 配置解析按两层写：typebox 原始 schema + 转换函数。**
`rawConfigSchema` 只声明本仓库真正读取的字段（`enabled` / `semantic_search` / `semantic` 的四个字段），未声明的键由解析层忽略，不设"未知键报错"；`toReadConfig` 负责补默认值、去尾斜杠、判定后端是否为受支持的外部类型。可选标量不再用 `Type.Unknown()` 兜住一切——那样等于没有 schema。

**7. 删除 `ast_edit` 实现而不是接线。**
`registerAstEditTool`（310 行）+ 其测试（297 行）从未被 `src/aft/index.ts` 调用，是彻底的死代码：没有调用点的注册函数不会出现在模型面上，留着只会持续制造 prompt 引用与 review 噪声。
_备选_：接线注册——否决，本 change 的原则是模型可见工具面只减不增；需要它时单独开 change 讨论参数面与写保护。

**8. 护栏用断言 + 文本校验双轨。**
`test/aft-index.test.ts` 断言注册出的工具名集合与"永不注册"名单互斥，并扫描 `src/aft/*.{md,ts}` 与工具 description，确保不出现未注册工具的标识符、也不出现自助回退语义。理由：只有注册面断言防不住注释与文档的措辞漂移，只有文本扫描防不住误注册。

## Risks / Trade-offs

- [明文密钥写进用户级 aft.jsonc，落盘可读] → 只接受用户级路径（项目级配置不读，与 aft 的 user-only 信任边界一致）；值只进子进程 env，测试断言 config tier 与工具输出不含密钥；用户仍可用 `api_key_env` 走 shell 变量。
- [外部后端不可达或密钥错误时，注册了工具却搜不到东西] → aft 侧会在 embedding 失败时报 `missing api_key_env` 或请求错误；`AFT_WAIT_FOR_SEMANTIC_READY` 保证不返回部分结果，失败信息透传给模型。
- [追加的 config tier 覆盖用户自己写的 `api_key_env`] → 仅发生在用户配了 `api_key` 却没配 `api_key_env` 时，此时用户意图就是"用配置里的值"，固定名是唯一自洽解。
- [30 秒等待把 callgraph 调用拉长，冷启动阶段连续几个查询都卡在窗口内] → 窗口内成功即返回真实结果，只发生一次；窗口耗尽返回 `callgraph_building` 软码，模型可自行重试而不是被抛错打断。
- [prompt 只字不提回退，模型可能以为改动不可恢复而过度保守] → 与"给出一个用不了的概念"相比，后者危害更大；需要恢复时用户会介入。
- [删掉 `aft_move` 推荐后模型改用 `Bash mv` 而非 `git mv`，丢 rename 历史] → `Bash` 本身有沙箱与审批，不新增风险面；`refactor.md` 不再指向任何不存在的工具。
- [删除 `ast-edit.ts` 后将来要重做] → git 历史可取回，其四种互斥参数面本就需要同步引擎 schema 后才该复活。
- [文本校验写成脆弱测试（改措辞即失败）] → 只断言未注册工具的标识符与回退关键词，不锁定整句文案。

## Migration Plan

1. `AFT_CALLGRAPH_BUILD_WAIT_MS` 与 `createAftPool` 的 `semantic` 参数（已完成，单点可回滚）。
2. `config.ts` 的外部后端解析与 `index.ts` 的注册门控、notify（已完成）。
3. prompt 与注释清理 + 删除 `ast_edit`（已完成）。
4. 用户侧要求：在用户级 aft.jsonc 写 `semantic_search: true` 与 `semantic` 块（`backend` / `base_url` / 可选 `api_key`）才会拿到 `aft_search`；否则维持现状（5 个工具）。
5. 无锁文件变更；扩展改动需重启 pi agent 才生效。
6. 回滚：`childEnv` 一行可单独 revert 回到 building 软码行为；门控与文档改动是纯减法与措辞，无数据迁移。

## Open Questions

- 30 秒窗口对本仓库是否偏小：callgraph 冷构建时长需实测一次；若明显超过 30 秒，再决定是调窗口还是同时提高 transport 预算（两处必须一起改，避免漂移）。
- 外部 embedding 端点首次全量索引在本仓库的实际耗时与配额：`AFT_WAIT_FOR_SEMANTIC_READY_MS` 现为 600s，若端点批量受限（`max_batch_size` 默认 64）可能需要更久，或需要提示用户缩小 `semantic.max_files`。
- 升级到 0.54 后 `aft_inspect` 是否值得重议：取决于新版是否真的报告 pending/stale 分类，属下一个 change 的判断。
