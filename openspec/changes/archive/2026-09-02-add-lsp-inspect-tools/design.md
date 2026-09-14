# Design: add-lsp-inspect-tools

## Context

`lsp-rename` 的三层结构已经验证了这条链路：client.ts 单服务器请求封装（open/touch 同步、ContentModified 重试、MethodNotFound 归类）→ `LspService` 多服务器分发（language 服务器、配置顺序首个成功）→ 共享工具壳（claude-code / opencode 两入口注册一行）。本次只读查询完全复用该结构；`textDocument/references` 的发送与收敛逻辑在 renameSymbol 覆盖校验里已存在，只需提取为可复用的公开请求。

## Goals / Non-Goals

**Goals:**

- 三个只读工具（find-definition / find-reference / inspect-hover）共享一套定位、探测、消歧与多服务器分发代码。
- hover 内容原样透传，归一化仅限结构层面（definition 的 Location/LocationLink 转坐标、references 转输出行）。
- 输出对模型可定位：1-based 坐标 + 行内容片段；references 带总量汇总与截断标注。

**Non-Goals:**

- 不做 `documentSymbol` / `workspaceSymbol`（与 aft_outline / aft_search 职责重叠）。
- 不做 hover 内容的语义归一化（人类能读的模型就能读）。
- 不给 `lsp-find-reference` 暴露 `includeDeclaration` 参数（固定包含声明处，对齐 rename 的覆盖校验口径）。

## Decisions

- **工具拆分而非单一 `query` 参数**：三个工具各自独立注册，参数 schema 一致但 description / promptGuidelines 各自聚焦；模型不需要理解枚举值，调用意图更直接。（备选：单工具 + query 枚举——省两个注册项，但工具描述会变得笼统。）
- **消歧以"格式化输出"为分组键**：候选探测结果先格式化成字符串再比较，一致即同一符号。结构化比较（对齐 rename 的 canonicalizeEdit）更严谨，但只读查询里"结果字符串相同"已足够安全——即使误判，模型拿到的也是正确答案。（备选：结构化 canonicalize——代码量翻倍，收益仅是理论上的误判防护。）
- **definition / references 的行片段在工具层读取**：client 返回纯坐标，工具层按需读目标文件行内容（带 per-call 缓存、读失败静默跳过片段）。片段对模型定位价值高，但不属于 LSP 协议数据。
- **NotSupported 用专门错误类**：`LspMethodNotSupportedError`（携带 serverID + method），服务层以此区分"跳过该服务器试下一个"与"真失败"，与 `RenameNotPossibleError` 的归类模式一致。
- **promptGuidelines 内联字符串**：三个工具的指引各只有两三行，不值得像 lsp-rename 那样单独建 md 文件。
- **测试走真实服务器 + fixture project**：新增 `test/fixtures/lsp-project/`（静态 TS 项目 + .pi/lsp.json 声明 vtsls），e2e 拷贝到临时目录后对真实 vtsls 跑全链路；mock-lsp-server.mjs 不再加新逻辑（只读查询的 MethodNotFound 分支由类型层保证，不单独测）。注意只读查询没有 rename 的收敛校验，e2e 里对"索引未就绪给出过时结果"做轮询重试。

## Risks / Trade-offs

- [definition 返回形状差异（Location | Location[] | LocationLink[] | null）] → 归一化函数集中处理全部形状，LocationLink 的 `targetSelectionRange` 缺省时回退 `targetRange`；非 file: URI 跳过。
- [大项目 references 输出爆炸] → 输出上限：每文件最多列 10 条片段（超出标注 +N）、文件数上限 30（超出按计数汇总）；截断显式标注，不静默丢弃。
- [hover 在服务器索引未就绪时返回 null] → 如实报告"没有 hover 信息"，模型可重试；不做轮询等待（与 definition/references 不同，hover null 是合法应答而非索引未完成的信号）。
- [同名消歧对 hover 的误判] → 两个不同符号 hover 输出相同时会视为同一符号返回——结果本身仍正确，可接受（见 Decisions）。
- [逐候选探测放大请求数] → 与 lsp-rename 相同的模式；候选只来自同一行内同名词，数量有限。

## Migration Plan

纯新增，无迁移。回滚 = 两个入口各删一行注册。

## Open Questions

（无）
