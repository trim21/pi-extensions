/**
 * approval-suggest —— "allow forever" 的建议规则生成：
 * 用 BashArity 表把命令归一成模式（`git checkout main` → `git checkout *`），
 * 供用户选择"永久允许"时写入配置。归一模式不参与规则判定——匹配引擎
 * （approval-rules）按命令原文做通配匹配。
 *
 * 参考实现：opencode packages/opencode/src/permission/arity.ts（Apache-2.0）
 */
import { readFileSync } from "node:fs";

import { type BashCommand, parseBashCommands } from "./approval-rules.js";

/**
 * 命令前缀 → 定义该命令的 token 数。`git checkout main` → `git` 的 arity 2，
 * 权限模式取前 2 个 token + `*`（`git checkout *`），避免具体参数进规则。
 * 表来自 opencode packages/opencode/src/permission/arity.ts（Apache-2.0），
 * 数据存放在 arity.json（所有 key 带引号）。
 */
const ARITY = JSON.parse(readFileSync(new URL("arity.json", import.meta.url), "utf8")) as Record<
  string,
  number
>;

/**
 * 生成命令的 BashArity 建议模式：BashArity 前缀 + `*`。
 * `git checkout main` → `git checkout *`；未收录的命令 → 命令名 + `*`。
 */
export function commandPattern(command: BashCommand): string {
  const tokens = [command.name, ...command.args];
  for (let len = tokens.length; len > 0; len--) {
    const prefix = tokens.slice(0, len).join(" ");
    const arity = ARITY[prefix];
    if (arity !== undefined) return [...tokens.slice(0, arity), "*"].join(" ");
  }
  if (tokens.length === 0) return "*";
  return [tokens[0], "*"].join(" ");
}

/** 命令（含所有嵌套命令）的 BashArity 建议模式列表（命令替换里的命令也展开）。 */
function patternsFromCommands(commands: BashCommand[]): string[] {
  const flat: string[] = [];
  const visit = (cmd: BashCommand) => {
    flat.push(commandPattern(cmd));
    for (const nested of cmd.nested) visit(nested);
  };
  for (const cmd of commands) visit(cmd);
  return flat;
}

export async function commandPatternsFor(command: string): Promise<string[]> {
  const parsed = await parseBashCommands(command);
  return patternsFromCommands(parsed.commands);
}
