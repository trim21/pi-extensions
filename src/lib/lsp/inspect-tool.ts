/**
 * 只读 LSP 符号查询工具，由 claude-code / opencode 两个工具集共享注册：
 *
 * - lsp-find-definition：textDocument/definition → 定义位置列表
 * - lsp-find-reference：textDocument/references（含声明处）→ 按文件分组
 * - lsp-inspect：textDocument/hover → hover 内容原样透传
 *
 * 三个工具共用 lsp-rename 的定位与消歧语义（file_path + line + symbol，
 * character 消歧）：按词边界枚举行内候选逐个探测，格式化输出一致即视为
 * 同一符号的多次出现，不一致报歧义并列出候选列号。
 */

import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Hover } from "vscode-languageserver-types";

import { resolvePathArg } from "../path.js";
import type { InspectLocation } from "./client.js";
import type { LspService } from "./lsp.js";
import { type LspPosition, symbolCandidates } from "./rename.js";

/** references 输出上限：每文件最多列出的行片段数。 */
const MAX_ENTRIES_PER_FILE = 10;
/** references 输出上限：最多列出片段的文件数，超出部分按计数汇总。 */
const MAX_FILES_LISTED = 30;
const MAX_SNIPPET_LENGTH = 200;

/** 一次探测的产出：text 是消歧分组键，subtitle 供 pendant 摘要。 */
interface InspectOutput {
  text: string;
  subtitle: string;
}

function loadPrompt(fileName: string): string {
  return readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), "utf8").trim();
}

const FIND_DEFINITION_PROMPT = loadPrompt("lsp-find-definition.md");
const FIND_REFERENCE_PROMPT = loadPrompt("lsp-find-reference.md");
const INSPECT_PROMPT = loadPrompt("lsp-inspect.md");

const POSITION_SCHEMA = Type.Object(
  {
    file_path: Type.String({
      description:
        "A file containing the symbol (absolute path, or relative / ~/ path resolved against the session cwd)",
    }),
    line: Type.Integer({
      minimum: 1,
      description:
        "1-based line number where the symbol appears (any occurrence works, not only the definition)",
    }),
    symbol: Type.String({
      minLength: 1,
      description: "The symbol's name exactly as it appears on that line",
    }),
    character: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "1-based character offset of the symbol on that line. Only needed when the tool reports an ambiguity error on this line",
      }),
    ),
  },
  { additionalProperties: false },
);

async function readSymbolFile(
  cwd: string,
  filePathArg: string,
): Promise<{ path: string; content: string }> {
  const filePath = resolvePathArg(cwd, filePathArg);
  try {
    await stat(filePath);
    const content = await readFile(filePath, "utf8");
    return { path: filePath, content };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`File does not exist: ${filePath}`, { cause: error });
    }
    throw error;
  }
}

/** 目标行内容片段（跨文件缓存；读取失败静默跳过片段，坐标仍然输出）。 */
async function lineSnippet(
  path: string,
  line: number,
  cache: Map<string, string[]>,
): Promise<string> {
  let lines = cache.get(path);
  if (lines === undefined) {
    try {
      const content = await readFile(path, "utf8");
      lines = content.split("\n");
    } catch {
      return "";
    }
    cache.set(path, lines);
  }
  const text = (lines[line] ?? "").replace(/\r$/, "");
  return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}…` : text;
}

function toCoordinates(location: InspectLocation): string {
  return `${location.path}:${location.line + 1}:${location.character + 1}`;
}

async function formatDefinitionLocations(
  locations: InspectLocation[],
  cache: Map<string, string[]>,
): Promise<InspectOutput> {
  if (locations.length === 0) {
    return { text: "No definition found for this symbol.", subtitle: "0 definition(s)" };
  }
  const lines = [`Found ${locations.length} definition(s):`];
  for (const location of locations) {
    const snippet = await lineSnippet(location.path, location.line, cache);
    lines.push(`- ${toCoordinates(location)}${snippet === "" ? "" : `\n  ${snippet}`}`);
  }
  return {
    text: lines.join("\n"),
    subtitle: `${locations.length} definition(s)`,
  };
}

async function formatReferenceLocations(
  locations: InspectLocation[],
  cache: Map<string, string[]>,
): Promise<InspectOutput> {
  if (locations.length === 0) {
    return { text: "No references found for this symbol.", subtitle: "0 reference(s)" };
  }
  const byPath = new Map<string, InspectLocation[]>();
  for (const location of locations) {
    const existing = byPath.get(location.path);
    if (existing) existing.push(location);
    else byPath.set(location.path, [location]);
  }
  const paths = [...byPath.keys()];
  const sections = [`Found ${locations.length} reference(s) in ${paths.length} file(s):`];
  for (const path of paths.slice(0, MAX_FILES_LISTED)) {
    const entries = byPath.get(path);
    if (!entries) continue;
    const shown = entries.slice(0, MAX_ENTRIES_PER_FILE);
    sections.push(`### ${path} (${entries.length})`);
    for (const entry of shown) {
      const snippet = await lineSnippet(path, entry.line, cache);
      sections.push(
        `- ${entry.line + 1}:${entry.character + 1}${snippet === "" ? "" : `: ${snippet}`}`,
      );
    }
    if (entries.length > shown.length) {
      sections.push(`(+${entries.length - shown.length} more in this file)`);
    }
  }
  const omitted = paths.slice(MAX_FILES_LISTED);
  if (omitted.length > 0) {
    const omittedCount = omitted.reduce((sum, path) => sum + (byPath.get(path)?.length ?? 0), 0);
    sections.push(`(+${omittedCount} reference(s) in ${omitted.length} more file(s) not shown)`);
  }
  return {
    text: sections.join("\n"),
    subtitle: `${locations.length} reference(s) in ${paths.length} file(s)`,
  };
}

type MarkedString = string | { language: string; value: string };

function formatMarkedString(marked: MarkedString): string {
  return typeof marked === "string" ? marked : `\`\`\`${marked.language}\n${marked.value}\n\`\`\``;
}

/** hover contents 原样透传：仅做结构格式化（MarkedString → code fence），不改写内容。 */
function formatHoverContents(contents: Hover["contents"]): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((marked) => formatMarkedString(marked)).join("\n\n");
  }
  if ("language" in contents) return formatMarkedString(contents);
  return contents.value;
}

/**
 * 行内同名候选逐个探测：输出一致即同一符号的多次出现；不一致报歧义并列出
 * 各候选的 1-based 列号（与 lsp-rename 的消歧行为一致）。
 */
async function probeSymbolCandidates(options: {
  content: string;
  filePath: string;
  line: number;
  symbol: string;
  character?: number;
  signal?: AbortSignal;
  probe: (position: LspPosition) => Promise<InspectOutput>;
}): Promise<InspectOutput> {
  const candidates = symbolCandidates(
    options.content,
    options.line - 1,
    options.symbol,
    options.character === undefined ? undefined : options.character - 1,
  );
  if (candidates.length === 0) {
    throw new Error(
      `Symbol "${options.symbol}" not found on line ${options.line} of ${options.filePath}. Read the file again and locate the symbol.`,
    );
  }
  const outputs: InspectOutput[] = [];
  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    outputs.push(await options.probe(candidate));
  }
  const groups = new Map<string, { output: InspectOutput; candidates: LspPosition[] }>();
  for (const [index, candidate] of candidates.entries()) {
    const output = outputs[index];
    if (!output) continue;
    const group = groups.get(output.text);
    if (group) group.candidates.push(candidate);
    else groups.set(output.text, { output, candidates: [candidate] });
  }
  if (groups.size > 1) {
    const listing = [...groups.values()]
      .map((group) =>
        group.candidates
          .map((candidate) => `- line ${candidate.line + 1}, column ${candidate.character + 1}`)
          .join("\n"),
      )
      .join("\n");
    throw new Error(
      `Ambiguous symbol on line ${options.line} of ${options.filePath}: several distinct symbols share the name "${options.symbol}". Retry with 'character' (1-based) to pick one:\n${listing}`,
    );
  }
  const first = [...groups.values()][0];
  if (!first) throw new Error("LSP inspect returned no result");
  return first.output;
}

export function registerLspInspectTools(pi: ExtensionAPI, service: LspService): void {
  pi.registerTool({
    name: "lsp-find-definition",
    label: "Lsp Find Definition",
    description:
      "Find where a code symbol is defined via LSP. Returns 1-based path:line:col locations with source line snippets.",
    promptSnippet: "Find symbol definitions via LSP",
    promptGuidelines: [FIND_DEFINITION_PROMPT],
    parameters: POSITION_SCHEMA,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { path: filePath, content } = await readSymbolFile(ctx.cwd, params.file_path);
      const cache = new Map<string, string[]>();
      const output = await probeSymbolCandidates({
        content,
        filePath,
        line: params.line,
        symbol: params.symbol,
        character: params.character,
        signal,
        probe: async (position) => {
          const result = await service.inspect({
            file: filePath,
            cwd: ctx.cwd,
            line: position.line,
            character: position.character,
            query: "definition",
            options: { signal },
          });
          return formatDefinitionLocations(result.locations, cache);
        },
      });
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          pendant: {
            title: "lsp-find-definition",
            subtitle: `${params.symbol} · ${output.subtitle}`,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "lsp-find-reference",
    label: "Lsp Find Reference",
    description:
      "Find all references to a code symbol across the workspace via LSP (includes the declaration). Grouped by file with 1-based line:col and source snippets.",
    promptSnippet: "Find symbol references via LSP",
    promptGuidelines: [FIND_REFERENCE_PROMPT],
    parameters: POSITION_SCHEMA,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { path: filePath, content } = await readSymbolFile(ctx.cwd, params.file_path);
      const cache = new Map<string, string[]>();
      const output = await probeSymbolCandidates({
        content,
        filePath,
        line: params.line,
        symbol: params.symbol,
        character: params.character,
        signal,
        probe: async (position) => {
          const result = await service.inspect({
            file: filePath,
            cwd: ctx.cwd,
            line: position.line,
            character: position.character,
            query: "references",
            options: { signal },
          });
          return formatReferenceLocations(result.locations, cache);
        },
      });
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          pendant: {
            title: "lsp-find-reference",
            subtitle: `${params.symbol} · ${output.subtitle}`,
          },
        },
      };
    },
  });

  pi.registerTool({
    name: "lsp-inspect",
    label: "Lsp Inspect",
    description:
      "Get hover information (type signature, documentation) for a code symbol via LSP. Content is passed through from the language server.",
    promptSnippet: "Get hover info for a symbol via LSP",
    promptGuidelines: [INSPECT_PROMPT],
    parameters: POSITION_SCHEMA,
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { path: filePath, content } = await readSymbolFile(ctx.cwd, params.file_path);
      const output = await probeSymbolCandidates({
        content,
        filePath,
        line: params.line,
        symbol: params.symbol,
        character: params.character,
        signal,
        probe: async (position) => {
          const result = await service.inspect({
            file: filePath,
            cwd: ctx.cwd,
            line: position.line,
            character: position.character,
            query: "hover",
            options: { signal },
          });
          if (result.hover === null) {
            return {
              text: `No hover information for '${params.symbol}' at line ${params.line} of ${filePath}.`,
              subtitle: "no hover info",
            };
          }
          return {
            text: formatHoverContents(result.hover.contents),
            subtitle: "hover",
          };
        },
      });
      return {
        content: [{ type: "text" as const, text: output.text }],
        details: {
          pendant: { title: "lsp-inspect", subtitle: `${params.symbol} · ${output.subtitle}` },
        },
      };
    },
  });
}
