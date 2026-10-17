# Proposal

## Why

`>&file` 是 `&>file` 的另一种写法（bash 把 `>&word` 且 `word` 不是 fd 号时当作重定向 stdout+stderr 到文件），但审批规则的解析只把 `>&` 无条件当作 fd 复制。于是 `echo `规则允许的命令可以写成 `echo '' >& file` 自动获得全权限执行并写文件，绕过「含写入文件的重定向不自动放行」这条保护。tree-sitter 把 `>& file` 解析成 `file_redirect` 下的 `>&` + `word`，而 `2>&1` 是 `file_descriptor` + `>&` + `number`；当前代码只看操作符类型，未检查目标节点。

## What Changes

- `fileRedirectWritesToFile` 识别 `>&` 目标：目标是 `number` 或 `-` 时视为 fd 复制/关闭，其余（`word`、`simple_expansion` 等）视为写文件，交人审；`2>&file` 与 `>&$fd` 这类静态无法确认的写法一并保守处理。
- 同步更新 `openspec/specs/bwrap/spec.md` 的「提权审批」，把 `>&file` 显式列为文件输出重定向，并补对应 scenario。
- 补回归测试：解析层断言各类 `>&` 写法的分类，审批层断言 `allow echo *` 下 `echo hi >& file` 不自动放行、`echo hi >&2` 仍自动放行。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `bwrap`：「提权审批」明确 `>&file` / `>&$fd` 属于含写入文件的重定向，不得因命令规则全匹配而自动放行；仅目标是 fd 号或 `-` 的 `>&` 才算 fd 复制。

## Impact

- 代码：`src/bwrap/approval-rules.ts`（重定向分类）。
- 规范：`openspec/specs/bwrap/spec.md`。
- 测试：`test/approval-rules.test.ts`。
- 不涉及配置格式、依赖或公共 API 变更；只让此前漏判的写法回到「交人审」，不改变已正确识别的 `>` / `>>` / `&>` / `<>` 等行为。
