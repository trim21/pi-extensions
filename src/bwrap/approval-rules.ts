/**
 * approval-rules —— bash 命令审核组件（对齐 opencode 的权限方法）：
 * 用 tree-sitter 解析命令（含嵌套 `$(...)`），按 BashArity 生成命令模式
 * （`git checkout main` → `git checkout *`），再用通配匹配对 allow/deny
 * 规则求值。接入 bwrap 的 `dangerouslyDisableSandbox` 审批：命中规则自动
 * 放行/拒绝，未命中才弹审批对话框。
 *
 * 参考实现：
 * - opencode packages/opencode/src/permission/arity.ts（BashArity 表）
 * - opencode packages/core/src/util/wildcard.ts（通配匹配）
 * - opencode packages/opencode/src/tool/shell.ts（tree-sitter 命令提取）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Node } from "web-tree-sitter";

import { resolvePackageWasm } from "../lib/wasm.js";

/** 解析后的单个命令：命令名 + 参数 + 原文 + 嵌套命令（命令替换里的）。 */
export interface BashCommand {
  name: string;
  args: string[];
  raw: string;
  nested: BashCommand[];
}

export interface ParsedBash {
  commands: BashCommand[];
  /** 语法错误时的提示（解析失败不抛错，退化为无法匹配）。 */
  error?: string;
}

export type ApprovalAction = "allow" | "deny";

export interface ApprovalRule {
  action: ApprovalAction;
  /** 命令模式，如 `git push *`、`curl *`、`npm install *`。 */
  pattern: string;
}

// ── tree-sitter ──────────────────────────────────────────────────────────────

interface BashParser {
  parse: (source: string) => unknown;
}

/**
 * 延迟初始化 tree-sitter bash parser（wasm 加载开销大，只做一次）。
 * Node 环境：主 wasm 由 web-tree-sitter 按自身路径自动加载，
 * bash grammar 的 wasm 显式读文件传入。
 */
function createParserLoader(): () => Promise<BashParser> {
  let parserPromise: Promise<BashParser> | undefined;
  return function loadParser(): Promise<BashParser> {
    parserPromise ??= (async () => {
      const { Language, Parser } = await import("web-tree-sitter");
      await Parser.init();
      const bashWasm = readFileSync(
        fileURLToPath(resolvePackageWasm("tree-sitter-bash", "tree-sitter-bash.wasm")),
      );
      const language = await Language.load(bashWasm);
      const parser = new Parser();
      parser.setLanguage(language);
      return { parse: (source: string) => parser.parse(source) };
    })();
    return parserPromise;
  };
}
const loadParser = createParserLoader();

// ── 命令提取（对齐 opencode shell.ts 的 commands/parts）────────────────────

/** 命令参数中需要跳过的节点类型。 */
const SKIP_ARG_TYPES = new Set(["command_argument_sep", "redirection"]);

function extractParts(node: Node): { name: string; args: string[] } {
  const name: string[] = [];
  const args: string[] = [];
  const visit = (child: Node) => {
    if (child.type === "command_name" || child.type === "command_name_expr") {
      name.push(child.text);
      return;
    }
    if (child.type === "command_elements") {
      for (let i = 0; i < child.childCount; i++) {
        const item = child.child(i);
        if (item && !SKIP_ARG_TYPES.has(item.type)) {
          // 参数词与命令替换都保留原文（命令替换内部的命令由 nested 提取）
          args.push(item.text);
        }
      }
      return;
    }
    if (
      child.type === "word" ||
      child.type === "string" ||
      child.type === "raw_string" ||
      child.type === "concatenation"
    ) {
      args.push(child.text);
    }
  };
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) visit(child);
  }
  return { name: name.join(" "), args };
}

function collectCommand(node: Node, all: Node[]): BashCommand | undefined {
  const { name, args } = extractParts(node);
  if (!name) return undefined;
  // 嵌套命令 = 完全落在本命令范围内的其他 command 节点（含 `$(...)` 内的）。
  // 用位置判断而非 descendantsOfType 递归：0.26 的 descendantsOfType 会包含
  // 自身且每次返回新 wrapper，`===` 比较失效会无限递归。
  const nested: BashCommand[] = [];
  for (const descendant of all) {
    if (descendant === node) continue;
    if (descendant.startIndex >= node.startIndex && descendant.endIndex <= node.endIndex) {
      const inner = collectCommand(descendant, all);
      if (inner) nested.push(inner);
    }
  }
  return { name, args, raw: node.text, nested };
}

/**
 * 解析 bash 命令，返回所有命令（含嵌套 `$(...)` 与管道两端）。
 * 语法错误时返回 `error` 而不抛错——审核失败应拒绝而非崩溃。
 */
export async function parseBashCommands(command: string): Promise<ParsedBash> {
  try {
    const parser = await loadParser();
    const tree = parser.parse(command) as { rootNode: Node };
    const all = tree.rootNode.descendantsOfType("command");
    const commands: BashCommand[] = [];
    for (const node of all) {
      const parsed = collectCommand(node, all);
      if (parsed) commands.push(parsed);
    }
    return { commands };
  } catch (error) {
    return {
      commands: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── BashArity：命令前缀 → token 数（参考 opencode arity.ts）─────────────────

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
 * 生成命令的权限模式：BashArity 前缀 + `*`。
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

// ── 通配匹配（参考 opencode wildcard.ts）────────────────────────────────────

/**
 * `*` 匹配任意字符序列，`?` 匹配单个字符；规则模式是正则字面量。
 * `git push *` 匹配 `git push main` 等。
 */
export function matchRule(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp(`^${escaped}$`, "s").test(input);
}

// ── 规则求值 ────────────────────────────────────────────────────────────────

/**
 * 命令（含所有嵌套命令）的权限模式列表（命令替换里的命令也展开）。
 * 供规则求值与"allow forever"写规则复用。
 */
export async function commandPatternsFor(command: string): Promise<string[]> {
  const parsed = await parseBashCommands(command);
  const flat: string[] = [];
  const visit = (cmd: BashCommand) => {
    flat.push(commandPattern(cmd));
    for (const nested of cmd.nested) visit(nested);
  };
  for (const cmd of parsed.commands) visit(cmd);
  return flat;
}

/**
 * 对命令（含所有嵌套命令）求值：任一命令命中规则即生效，规则后写优先
 * （findLast，对齐 opencode PermissionV2）。返回 allow/deny；无规则命中
 * 返回 undefined（交给人审）。
 */
export function evaluateBashApproval(
  command: string,
  rules: readonly ApprovalRule[],
): Promise<ApprovalAction | undefined> {
  return commandPatternsFor(command).then((patterns) => {
    if (patterns.length === 0) return;
    // 规则后写优先（对齐 opencode PermissionV2 的 findLast）
    for (const pattern of patterns) {
      const rule = rules.findLast((r) => matchRule(pattern, r.pattern));
      if (rule) return rule.action;
    }
    return;
  });
}
