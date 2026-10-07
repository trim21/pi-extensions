# Tasks

## 1. 面板两段式改造

- [x] 1.1 在 `src/codemode/tool.ts` 抽出「按内容里最长反引号串挑围栏」的 helper，把 `scriptPendant(code, subtitle)` 改成 `## Input`（js 代码块）+ 可选 `## Output`（代码块）两段；输出为空串/只有空白时不出 Output 段。验证：`test/codemode-tool.test.ts` 新增用例——无输出时正文只有 Input 段，有输出时 Output 段内容与 `text()` 一致，输出内含反引号串时围栏自适应
- [x] 1.2 成功结果与失败结果改用 `outcome.output` 的文本输出调用新签名（成功路径不含 `return` 值 JSON、不含图片；失败路径放脚本已产生的输出）。验证：测试断言 `text("hi")` 成功调用的 Output 段为 `hi`、且不出现返回值 JSON；失败脚本（先 `text("partial")` 后抛错）的面板 Output 段含 `partial`
- [x] 1.3 解析失败（非法 `@options`）路径用 `params.code` 构造面板：有 Input 段、无 Output 段。验证：测试断言该错误结果的面板正文只有 Input 段

## 2. 副标题的输出字符数

- [x] 2.1 `scriptPendant` 的副标题追加文本输出字符数（` · <N> chars output`，按 `text.length` 口径）：成功路径用完整输出的长度、失败路径用已产生输出的长度、解析失败为 0。验证：`test/codemode-tool.test.ts` 断言 `text("hi")` 的副标题含 `2 chars output`、失败脚本含已产生文本的字符数、非法 `@options` 为 0

## 3. 进度面板累计输出

- [x] 3.1 在 `execute` 里用累计字符串接住 `onOutput` 的文本项，`onOutput` 与 `onCallProgress` 两处 `onUpdate` 都把累计值传给 `scriptPendant`（嵌套调用行继续作副标题，字符数为累计值）。验证：测试按 `text("a")` → 调用工具 → `text("b")` 的顺序断言进度更新的 Output 段依次为 `a`、`a\nb`，副标题为当前调用且字符数依次为 1、3

## 4. 回归验证

- [x] 4.1 运行 `pnpm test`（codemode 相关用例全绿）、`pnpm check`、`pnpm lint`，并确认没有其它测试依赖旧的面板正文格式
