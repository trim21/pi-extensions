### aft_refactor tool

workspace-wide 重构：跨文件移动符号、抽函数、内联，自动更新引用与 import。

- `move`：把顶层符号（非嵌套函数/类方法）移到另一个文件，全 workspace 重写 import 与引用；执行前自动创建 checkpoint。需要 `symbol` + `destination`；同名符号歧义时用 `scope` 消歧。注意：move / rename 整个文件请用 aft_move（OS 层操作，不更新引用）。
- `extract`：把行区间抽成新函数（TS/JS/TSX、Python）。需要 `name` + `start_line` + `end_line`（1 起，含端点）。
- `inline`：把调用点替换为函数体。需要 `symbol` + `call_site_line`（1 起）。

重构是写操作：不支持 preview（无 diff 预览），写保护退化为路径级审批——workspace 内目标自动放行，外部路径需要确认。重构前先看影响面：对目标符号跑 aft_callgraph `impact`，确认波及范围符合预期再动手。
