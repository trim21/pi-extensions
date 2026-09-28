/**
 * approval-rules —— bash 命令匹配引擎（对齐 opencode 的权限方法）：
 * 用 tree-sitter 解析命令（含嵌套 `$(...)`），对每条命令的原文做通配
 * 匹配，对 allow/deny 规则求值。规则匹配不经过任何命令归一——BashArity
 * 归一模式只用于 "allow forever" 的建议规则（见 approval-suggest.ts）。
 * 接入 bwrap 的 `dangerouslyDisableSandbox` 审批：审批规则集
 * （createApprovalRuleSet）独占「自动放行 / 自动拒绝 / 交人审」的判定、
 * allow 覆盖查询、待允许模式与规则追加，调用方只描述用户动作。
 * 文件输出重定向（`>` / `>>` / `&>` 等）不会因命令规则自动放行，
 * 避免 `echo *` 把 `echo '' > file` 带过。
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
    if (child) {
      visit(child);
    }
  }
  return { name: name.join(" "), args };
}

/** 会打开/截断/追加文件的重定向算子；`>&` / `<&` 是 fd 复制，不算。 */
const FILE_OUTPUT_REDIRECT_OPS = new Set([">", ">>", ">|", "&>", "&>>"]);

function fileRedirectWritesToFile(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) {
      continue;
    }
    if (FILE_OUTPUT_REDIRECT_OPS.has(child.type)) {
      return true;
    }
    // `<>` 被解析成 `<` + 含 `>` 的 ERROR
    if (child.type === "ERROR" && child.text.includes(">")) {
      return true;
    }
  }
  return false;
}

function treeHasFileOutputRedirect(root: Node): boolean {
  for (const node of root.descendantsOfType("file_redirect")) {
    if (fileRedirectWritesToFile(node)) {
      return true;
    }
  }
  return false;
}

function collectCommand(node: Node, all: Node[]): BashCommand | undefined {
  const { name, args } = extractParts(node);
  if (!name) {
    return undefined;
  }
  // 嵌套命令 = 完全落在本命令范围内的其他 command 节点（含 `$(...)` 内的）。
  // 用位置判断而非 descendantsOfType 递归：0.26 的 descendantsOfType 会包含
  // 自身且每次返回新 wrapper，`===` 比较失效会无限递归。
  const nested: BashCommand[] = [];
  for (const descendant of all) {
    if (descendant === node) {
      continue;
    }
    if (descendant.startIndex < node.startIndex || descendant.endIndex > node.endIndex) {
      continue;
    }
    const inner = collectCommand(descendant, all);
    if (inner) {
      nested.push(inner);
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
      if (parsed) {
        commands.push(parsed);
      }
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
  if (escaped.endsWith(" .*")) {
    escaped = escaped.slice(0, -3) + "( .*)?";
  }
  return new RegExp(`^${escaped}$`, "s").test(input);
}

// ── 命令树展平 ──────────────────────────────────────────────────────────────

/**
 * 展平命令树：每条命令本身 + 其所有嵌套命令（`$(...)` 内的），父在子前。
 * 求值与建议模式生成（approval-suggest.ts）共用——后者依赖本模块，
 * 反向 import 会成环，所以展平放在这里。
 */
export function flattenCommands(parsed: ParsedBash): BashCommand[] {
  const flat: BashCommand[] = [];
  const visit = (cmd: BashCommand) => {
    flat.push(cmd);
    for (const nested of cmd.nested) {
      visit(nested);
    }
  };
  for (const cmd of parsed.commands) {
    visit(cmd);
  }
  return flat;
}

// ── 审批规则集 ──────────────────────────────────────────────────────────────

export interface ApprovalRuleSetOptions {
  /** 当前规则（读取时取最新，追加后无需重建规则集）。规则数组即优先级：靠后优先。 */
  rules: () => readonly ApprovalRule[];
  /** 命令 → 候选模式（BashArity）；注入以免与 approval-suggest.ts 成环。 */
  suggestPatterns: (command: string) => Promise<readonly string[]>;
  /** 追加 allow 规则并持久化；resolve 后 rules() 必须能看到它们，抛错即视为未追加。 */
  persist: (rules: readonly ApprovalRule[]) => Promise<void>;
}

export interface ApprovalRuleSet {
  /**
   * 对命令（含所有嵌套命令）求值：deny 优先 / allow 需全量 / 含文件输出
   * 重定向不自动放行。返回 undefined 表示未命中规则，交人工审批。
   */
  evaluate(command: string): Promise<ApprovalAction | undefined>;
  /**
   * 该字符串（命令原文或候选模式）是否被最后一条匹配的规则允许。
   * 只回答 allow 覆盖，不考虑 deny 与重定向——放行判定一律用 evaluate。
   */
  isAllowed(pattern: string): boolean;
  /** 命令的候选模式（去重）中尚未被 allow 规则覆盖的那些；审批子菜单的唯一来源。 */
  pendingPatterns(command: string): Promise<string[]>;
  /** 追加 allow 规则并持久化；persist 成功后立即生效。 */
  addAllowRules(patterns: readonly string[]): Promise<void>;
}

/**
 * 审批规则集：命令自动判定、allow 覆盖查询、待允许模式与规则追加的唯一 owner。
 * 规则数组的顺序即优先级：靠后优先（项目规则经 deepMerge 排在全局规则之后）。
 * 三条协作方由调用方注入：规则 getter（reload 或追加后无需重建规则集）、
 * 候选模式生成、持久化副作用（文件读写留在调用方）。
 */
export function createApprovalRuleSet(options: ApprovalRuleSetOptions): ApprovalRuleSet {
  const { rules, suggestPatterns, persist } = options;

  /** 最后一条匹配 input 的规则；数组靠后者优先（对齐 opencode PermissionV2）。 */
  function lastMatch(input: string): ApprovalRule | undefined {
    return rules().findLast((rule) => matchRule(input, rule.pattern));
  }

  function isAllowed(pattern: string): boolean {
    return lastMatch(pattern)?.action === "allow";
  }

  async function evaluate(command: string): Promise<ApprovalAction | undefined> {
    const parsed = await parseBashCommands(command);
    // 匹配输入是命令原文（tree-sitter command 节点 text，含嵌套逐条展开），
    // 对齐 opencode shell.ts 的 patterns；通配规则按字面写，`--` 与普通 token 无区别。
    const raws = flattenCommands(parsed).map((cmd) => cmd.raw);
    if (raws.length === 0) {
      return; // 空命令或解析失败：没有可匹配的命令，交人审
    }
    let allowed = 0;
    for (const raw of raws) {
      const rule = lastMatch(raw);
      if (rule?.action === "deny") {
        return "deny";
      }
      if (rule?.action === "allow") {
        allowed++;
      }
    }
    // 文件输出重定向不自动放行：即使命令规则全匹配也交人审
    if (parsed.hasFileOutputRedirect) {
      return;
    }
    // allow 需全量：有命令未命中规则时交人审，避免未允许的命令被同链放行带过
    return allowed === raws.length ? "allow" : undefined;
  }

  async function pendingPatterns(command: string): Promise<string[]> {
    const pending: string[] = [];
    const seen = new Set<string>();
    for (const pattern of await suggestPatterns(command)) {
      if (seen.has(pattern) || isAllowed(pattern)) {
        continue;
      }
      seen.add(pattern);
      pending.push(pattern);
    }
    return pending;
  }

  async function addAllowRules(patterns: readonly string[]): Promise<void> {
    const additions: ApprovalRule[] = patterns.map((pattern) => ({ action: "allow", pattern }));
    if (additions.length === 0) {
      return; // 解析失败或未勾选：本次处理，不写配置
    }
    await persist(additions);
  }

  return { evaluate, isAllowed, pendingPatterns, addAllowRules };
}
