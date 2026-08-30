## 1. callgraph 未就绪的内联等待

- [x] 1.1 在 `src/aft/bridge.ts` 的 `createAftPool` → `poolOptions.childEnv` 中加入 `AFT_CALLGRAPH_BUILD_WAIT_MS`，值取自导出常量 `CALLGRAPH_BUILD_WAIT_MS = 30_000`，并注释说明窗口须明显小于 transport 的 callgraph 60s 预算（设计决策 1），验证：`pnpm check` 无类型错误
- [x] 1.2 `test/aft-bridge.test.ts`：mock `@cortexkit/aft-bridge`，断言三个引擎侧 env 键齐备、callgraph 窗口在 0..60s 之间，验证：fail-first 已确认（注释掉实现行即 `expected undefined to be '30000'`），当前 6 passed
- [x] 1.3 更新 `src/aft/callgraph.md`：未就绪时会在窗口内等待，仍返回 `callgraph_building` 时稍后重试同一查询，验证：`pnpm check` 通过
- [x] 1.4 重启 pi 后实测 `aft_callgraph` 的 `trace_to_symbol` 与 `trace_data`，验证：返回真实路径结果而非 `callgraph_building`；若仍超时，记录实测构建耗时以回答 design 的 Open Question

## 2. 语义搜索走外部 embedding 后端

- [x] 2.1 `src/aft/config.ts` 改为两层解析：typebox `rawConfigSchema`（只声明 `enabled` / `semantic_search` / `semantic.{backend,base_url,api_key_env,api_key}`）+ `toReadConfig` 补默认值与后端判定；可选标量不再用 `Type.Unknown()`，验证：`test/aft-config.test.ts` 16 passed（含 fastembed 拒绝、缺 base_url 拒绝、未知 backend 拒绝、api_key 取值 trim、api_key_env 保留）
- [x] 2.2 `src/aft/bridge.ts`：导出 `SEMANTIC_API_KEY_ENV = "AFT_SEMANTIC_API_KEY"`，`createAftPool(cwd, semantic?)` 在配了 `api_key` 时注入 `childEnv[apiKeyEnv ?? 固定名]`，且用户未指定变量名时追加 `inlineUserConfigTier({ semantic: { api_key_env } })`，验证：`test/aft-bridge.test.ts` 覆盖三种组合（都不配 / 只配值 / 值+指定名）并断言密钥不出现在任何 config tier 的 doc 里
- [x] 2.3 `src/aft/index.ts`：`aft_search` 只在 `semanticSearch && semanticRemote` 时注册，否则 session 开始 notify 缺失原因；文件头注释改为外部后端约定，验证：`test/aft-index.test.ts` 断言 flag-only 时不注册且有 warning notify、外部后端就绪时注册且无 notify
- [x] 2.4 `src/aft/search.md` 与 `tools.ts` 的 `aft_search` description 删掉"需要怎么配置才会注册"这类对模型无意义的说明，只保留"首次调用会等索引构建"，验证：`pnpm check` 与 `pnpm lint` 通过

## 3. 移除 ast_edit 死代码

- [x] 3.1 删除 `src/aft/ast-edit.ts`（310 行）与 `test/aft-ast-edit.test.ts`（297 行），验证：`grep -rn "ast-edit\|ast_edit\|AstEdit" src test` 无命中
- [x] 3.2 改写 `src/aft/refactor.ts` 模块注释，不再拿未注册的 `ast_edit` 做对比，验证：`pnpm check` 通过、`refactor.md` 示例引用的行号与新文件行号一致（`start_line` 121 / `end_line` 134 / `call_site_line` 97）

## 4. 清理过期 prompt

- [x] 4.1 `src/aft/refactor.md` 删除"整文件 move / rename 请用 aft_move"与"执行前自动创建 checkpoint"（设计决策 3：不提模型用不了的概念），验证：文件内无 `aft_move` / checkpoint / 撤销字样
- [x] 4.2 `src/aft/refactor.ts:77` 的 description 删除对 `aft_move` 的推荐，验证：`grep -n aft_move src/aft/refactor.ts` 无命中
- [x] 4.3 `src/aft/refactor.md` 示例段末句只保留"只支持顶层符号"，不再指向 OS 层移动，验证：`pnpm check` 通过
- [x] 4.4 `src/aft/outline.md` 的分工句去掉 `aft_search`（条件注册工具不被其它 prompt 引用），验证：`test/aft-index.test.ts` 的文本扫描通过
- [x] 4.5 复核其余 aft prompt 与注释无悬空工具名，验证：`grep -rn "aft_move\|aft_delete\|aft_safety\|aft_inspect\|aft_conflicts\|ast_edit" src/aft` 无命中

## 5. 回归护栏

- [x] 5.1 新建 `test/aft-index.test.ts`：断言 semantic_search 关闭时注册面恰为 5 个工具、外部后端就绪时多出 `aft_search`、`enabled: false` 时为空，并逐个断言 `aft_move` / `aft_delete` / `aft_safety` / `aft_inspect` / `aft_conflicts` / `ast_edit` 永不注册，验证：12 passed，且临时注册一个禁用语工具即失败
- [x] 5.2 同文件补文本护栏：扫描 `src/aft/*.{md,ts}` 不含未注册工具标识符、扫描工具 description 不含撤销/回退/恢复/undo/restore/checkpoint 语义，验证：`pnpm vitest run test/aft-index.test.ts` 全绿

## 6. 收尾

- [x] 6.1 在 `AGENTS.md` 项目结构树补 `src/aft/` 条目（当前缺失该目录说明），验证：人工检查 diff 仅新增该条目
- [x] 6.2 全量验证：`pnpm check`、`pnpm lint`、`pnpm test` 全绿，验证：830 passed | 3 skipped，eslint 无输出，tsc + prettier 无错误
- [x] 6.3 `openspec validate expand-aft-tool-surface --strict` 无 warning，验证：命令输出 `is valid`
- [x] 6.4 配置真实外部 embedding 端点后重启 pi 冒烟：`aft_search` 出现在工具表、首次调用能返回结果、`~/.local/share/cortexkit/aft` 下的索引可构建；同时记录耗时回答 design 的 Open Question，验证：一次真实搜索返回语义结果
- [x] 6.5 归档前 review 最终 diff（`git diff --stat` 应为 10 改 + 2 删 + 2 新测试 + openspec 目录），确认无调试代码与无关格式化，验证：人工 review 通过
