### aft_refactor tool

workspace-wide 重构：跨文件移动符号、抽函数、内联，自动更新引用与 import。

- `move`：把顶层符号（非嵌套函数/类方法）移到另一个文件，全 workspace 重写 import 与引用。需要 `symbol` + `destination`；同名符号歧义时用 `scope` 消歧。
- `extract`：把行区间抽成新函数（TS/JS/TSX、Python）。需要 `name` + `start_line` + `end_line`（1 起，含端点）。
- `inline`：把调用点替换为函数体。需要 `symbol` + `call_site_line`（1 起）。

重构前先看影响面：对目标符号跑 aft_callgraph `impact`，确认波及范围符合预期再动手。

#### 示例

`path` 相对项目根，行号 1 起且含端点。

跨文件移动顶层符号，自动重写全部 import 与引用：

```json
{
  "op": "move",
  "path": "src/aft/tools.ts",
  "symbol": "buildPendantMarkdown",
  "destination": "src/lib/pendant.ts"
}
```

把行区间抽成新函数（先用 aft_outline 或 Read 定位区间）：

```json
{
  "op": "extract",
  "path": "src/aft/refactor.ts",
  "name": "buildRefactorArgs",
  "start_line": 121,
  "end_line": 134
}
```

`start_line` / `end_line` 指 `path` 文件里被抽取的代码，不是新函数所在的行。

内联单个调用点：

```json
{
  "op": "inline",
  "path": "src/aft/refactor.ts",
  "symbol": "requireField",
  "call_site_line": 98
}
```

`call_site_line` 是调用发生的那一行，不是函数定义行；只替换指定那一处，内联掉全部调用点后原定义不会被自动删除，需要自己清理。

只支持顶层符号；嵌套函数与类方法不适用。
