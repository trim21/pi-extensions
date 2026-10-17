# Proposal

## Why

`aft_outline` 的 spec、参数描述与 guidelines 仍写「符号大纲输出上限 30KB，超限截断」和「目录递归上限 200 文件」，但扩展不做本地截断，钉住的引擎实际使用 `walk_limit = 10000`，二进制里也没有 30KB 常量。这些数字会误导模型和后续实现。

## What Changes

- 删除 30KB 截断的描述，改为「输出由引擎渲染与截断」。
- 目录遍历上限统一为引擎的 `walk_limit`（当前 10000 文件）。
- 同步 `openspec/specs/aft/spec.md`、`src/aft/outline.md` 与 `src/aft/tools.ts` 的参数描述。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无，spec 已直接同步）

## Impact

- 代码/文档：`src/aft/outline.md`、`src/aft/tools.ts`。
- 规范：`openspec/specs/aft/spec.md`。
