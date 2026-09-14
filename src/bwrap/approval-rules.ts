/**
 * approval-rules —— bash 命令匹配引擎（对齐 opencode 的权限方法）：
 * 用 tree-sitter 解析命令（含嵌套 `$(...)`），对每条命令的原文做通配
 * 匹配，对 allow/deny 规则求值。规则匹配不经过任何命令归一——BashArity
 * 归一模式只用于 "allow forever" 的建议规则（见 approval-suggest.ts）。
 * 接入 bwrap 的 `dangerouslyDisableSandbox` 审批：命中规则自动
 * 放行/拒绝，未命中才弹审批对话框。文件输出重定向（`>` / `>>` / `&>`
 * 等）不会因命令规则自动放行，避免 `echo *` 把 `echo '' > file` 带过。
 *
 * 参考实现：
 * - opencode packages/core/src/util/wildcard.ts（通配匹配）
 * - opencode packages/opencode/src/tool/shell.ts（tree-sitter 命令提取）
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { Language, type Node, Parser } from "web-tree-sitter";

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
  /** 含写入文件的重定向（`>` / `>>` / `&>` / `<>` 等）；fd 复制与纯输入除外。 */
  hasFileOutputRedirect: boolean;
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
 * 延迟初始化 tree-sitter bash parser：web-tree-sitter 是静态 import，
 * 但 wasm 加载与 parser 构造只在首次调用时发生（Parser.init() 开销大）。
 * bash grammar 的 wasm 在模块加载时从 runtime 依赖
 * @vscode/tree-sitter-wasm（MIT）解析并读取一次。
 */
const require = createRequire(import.meta.url);
const BASH_WASM = readFileSync(
  require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm"),
);

function createParserLoader(): () => Promise<BashParser> {
  let parserPromise: Promise<BashParser> | undefined;
  return function loadParser(): Promise<BashParser> {
    parserPromise ??= (async () => {
      await Parser.init();
      const language = await Language.load(BASH_WASM);
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

/** 会打开/截断/追加文件的重定向算子；`>&` / `<&` 是 fd 复制，不算。 */
const FILE_OUTPUT_REDIRECT_OPS = new Set([">", ">>", ">|", "&>", "&>>"]);

function fileRedirectWritesToFile(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (FILE_OUTPUT_REDIRECT_OPS.has(child.type)) return true;
    // `<>` 被解析成 `<` + 含 `>` 的 ERROR
    if (child.type === "ERROR" && child.text.includes(">")) return true;
  }
  return false;
}

function treeHasFileOutputRedirect(root: Node): boolean {
  for (const node of root.descendantsOfType("file_redirect")) {
    if (fileRedirectWritesToFile(node)) return true;
  }
  return false;
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
    return { commands, hasFileOutputRedirect: treeHasFileOutputRedirect(tree.rootNode) };
  } catch (error) {
    return {
      commands: [],
      hasFileOutputRedirect: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
 * 对命令（含所有嵌套命令）求值：
 * - deny 优先：任一命令命中 deny 规则即整体拒绝
 * - 文件输出重定向不自动放行：即使命令规则全匹配，也返回 undefined 交人审
 * - allow 需全量：所有命令都命中 allow 规则才整体放行，否则返回
 *   undefined（有命令未命中规则，交给人审），避免未允许的命令被同链放行带过。
 * - 匹配输入是命令原文（tree-sitter command 节点 text，含嵌套逐条展开），
 *   对齐 opencode shell.ts 的 patterns；通配规则按字面写，`--` 与普通
 *   token 无区别。
 * 规则内后写优先（findLast，对齐 opencode PermissionV2）。
 */
export async function evaluateBashApproval(
  command: string,
  rules: readonly ApprovalRule[],
): Promise<ApprovalAction | undefined> {
  const parsed = await parseBashCommands(command);
  const raws: string[] = [];
  const visit = (cmd: BashCommand) => {
    raws.push(cmd.raw);
    for (const nested of cmd.nested) visit(nested);
  };
  for (const cmd of parsed.commands) visit(cmd);
  if (raws.length === 0) return;
  let allowed = 0;
  for (const raw of raws) {
    const rule = rules.findLast((r) => matchRule(raw, r.pattern));
    if (rule?.action === "deny") return "deny";
    if (rule?.action === "allow") allowed++;
  }
  if (parsed.hasFileOutputRedirect) return;
  return allowed === raws.length ? "allow" : undefined;
}
