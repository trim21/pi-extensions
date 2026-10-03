# gh 文本类工具改走 `--json` 并带上结构化结果

## Why

18 个 gh 工具里有 8 个（`list-github-issues`、`list-github-prs`、`list-github-releases`、`list-github-workflow-runs`、`read-github-repo`、`read-github-release`、`read-github-pr-diff`、`watch-github-run`）只把 gh 的**人类可读文本**给模型：`gh issue list` 的表格、`gh repo view` 的字段块、`gh release view` 的 markdown。文本里其实都来自结构化数据，但我们把它扔了，于是：

- 脚本拿不到可用的载荷（按 codemode 的准入条件，没有 `structuredSchema` 就不进可调用集合），模型想按字段过滤只能自己解析表格；
- issue/PR 列表的两条分支格式不一致：带关键词的搜索给 TSV（`renderHits`），不带关键词的浏览给 gh 的表格。

## What Changes

- **浏览分支改走 `gh … --json`**，与搜索分支归一到同一套 `SearchHit`（`state` 大小写、`comments` 计数、日期取日期部分都由归一化处理），文本统一由 `renderHits` 渲染成 TSV。`fields` 参数因此对两条分支都生效（以前只对搜索生效）。
- **`list-github-releases` / `list-github-workflow-runs` / `read-github-repo` / `read-github-release` 同样改走 `--json`**，文本由我们自己的渲染器生成（`src/gh/render.ts`）：一行一个 release / run、仓库概览几行、release 详情带资产清单与正文。
- **载荷 = gh 的 JSON 原样 + `text`**（与工具输出一致的那份文本），与已有 10 个工具的透传取向一致。文本可能被 2000 行 / 50KB 预算截断，载荷不受影响。
- **`read-github-pr-diff` 不改调用**：`gh pr diff` 没有 `--json`，文本仍是原始 diff，载荷由同一份 diff 解析出变更统计（文件、增删行数、`oldPath`），二进制文件与纯模式变更按 0 行计。
- **`watch-github-run` 收尾多一次 `gh run view --json`**（`gh run watch` 也没有 `--json`）：文本不变，载荷带最终运行状态。

## Impact

- `src/lib/github.ts`：新增 `normalizeGhList`（gh GraphQL 的 issue/PR 列表 → `SearchHit`）与 `dateOnly`（导出）。
- `src/gh/base.ts`：`listGithub` / `searchList` 换成 `browseList`（要 `--json`）与 `renderHitList`（两条分支共用渲染）。
- `src/gh/render.ts`（新）：release/run/repo/release-detail 渲染器 + `parseDiffStats`。
- `src/gh/schemas.ts`：8 个新载荷 schema。
- 8 个工具文件。
- 测试：新增 `test/gh-render.test.ts`（渲染器 + diff 解析）与 `test/gh-browse-list.test.ts`（浏览/搜索两条分支的文本与载荷）。

## Out of Scope

- `read-github-release` 的正文（release notes）仍是 markdown 文本，不解析成结构。
- `read-github-pr-diff` 不额外调 `gh pr view --json files`：一次请求换更精确的统计，但会让「读 diff」变成两次调用；解析同一份 diff 已经够用。
- `read-github-ci-logs` / `get-github-workflow-jobs` 等已有结构化结果的工具不动。
