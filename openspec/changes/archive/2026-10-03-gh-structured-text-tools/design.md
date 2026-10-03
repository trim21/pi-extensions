# Design

## D1：为什么浏览分支也改走 `--json`，而不是额外再发一次请求

要结构化数据有三条路：

1. **改调用**（选中）：浏览分支本来就要发 `gh issue list`，把它的输出格式从表格换成 `--json` 是一行参数的事，数据在同一份响应里。代价是文本格式变了（gh 的表格 → 我们的 TSV），且渲染代码归我们维护。
2. **额外再发一次请求**：文本一点不动，另发一次 `--json` 调用（pr-diff 还要补 `gh pr view --json files`）。代价是每次调用延迟翻倍、API 配额翻倍，而且两次响应之间上游会变，文本与载荷可能不一致。
3. **不做**：维持现状，这些工具不进 codemode。

选 1：文本格式本来就不是契约（模型读 TSV 与读表格没有差别），而「一份数据、一份真相」是这批工具此前 10 个结构化工具的做法（它们的载荷直接就是同一份 JSON）。选 2 的不一致问题在「读 diff 的统计」与「列 run 的状态」上尤其难受。

副产品：issue/PR 列表的两条分支现在格式一致了（此前搜索给 TSV、浏览给 gh 表格），`fields` 参数对两条分支都生效。

## D2：载荷的边界——gh 的 JSON + `text`

这 8 个工具的共同形状：

```ts
{ text: string; ...gh 的字段 }
```

`text` 与工具输出逐字一致（方便脚本做字符串判断或回喂），其余字段原样透传 gh 的 JSON（字段名保持 gh 的 camelCase，不重命名成我们的风格）——与已有 10 个工具一致，也让「gh 升了版本、多了字段」不需要我们改代码。schema 因此允许额外字段，只对我们真正依赖的字段做类型约束。

行列表类工具的载荷给出**全部**条目，不跟文本的输出预算（2000 行 / 50KB）缩水：与 AFT、Bash 同一口径——截断是渲染给模型看的事。

## D3：`read-github-pr-diff` 与 `watch-github-run` 的例外

两者都没有 `--json` 可用：

- `pr-diff`：解析同一份 diff 文本。解析只依赖 diff 的结构标记（`diff --git` / `---` / `+++` / `@@`），不碰文件内容；路径优先取 `diff --git` 头（二进制与纯模式变更没有 `---` / `+++` 行），删除的文件用旧路径。二选一里的另一半（补一次 `gh pr view --json files`）被否掉见 D1。
- `watch-github-run`：`gh run watch` 的文本只有过程，最终状态要另查一次 `gh run view --json`。这是唯一一处「多一次请求」，因为 watch 的用途就是等结束，收尾时拿状态是它的核心产出，且此时请求已经不影响延迟（时间花在等待上）。

## D4：归一化的位置

issue/PR 的两条分支（GraphQL 的 `gh … --json` 与 REST 的搜索）字段命名与语义都不同：`state` 大小写不同、`comments` 一个是数组一个是数字、`labels` 一个是 `{name}` 数组一个是字符串数组、日期是完整 ISO 时间戳。归一到 `SearchHit` 放在 `src/lib/github.ts`（`normalizeGhList`），因为那里已经有 `SearchHit`、`FIELD_EXTRACTORS` 与 `renderHits`——渲染与载荷因此都只认这一种形状，`browseList` 只负责发命令。

`merged` 由 `mergedAt` 推断（gh 对已合并的 PR 给 `state: MERGED`，搜索 API 给 `state: closed` + `merged_at`）：归一化后两条分支语义一致。

## D5：渲染器是纯函数

`src/gh/render.ts` 里全是「JSON 进、文本出」的纯函数，测试直接断言输出字符串（`test/gh-render.test.ts`），不需要假 gh 进程；工具层的接线由 `test/gh-browse-list.test.ts` 用假 `gh` 覆盖一条。这样文本格式的改动有稳定的回归点，而 gh 调用的参数组装由既有的 argv 测试覆盖。
