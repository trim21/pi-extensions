/**
 * codemode 脚本源码的解析：首行可选的 `// @options: {"max_output_tokens":…}`。
 *
 * 选项行与脚本首行共用一行，解析后原样保留为空行，脚本里报错的行号因此与用户写的
 * 一致。解析失败（空输入、JSON 非法、未知字段、只有选项行没有代码）直接报错。
 */

const OPTIONS_PREFIX = "// @options:";
const SUPPORTED_FIELDS = ["max_output_tokens"] as const;

export const DEFAULT_OUTPUT_TOKENS = 10_000;

export class CodemodeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodeSourceError";
  }
}

export interface CodemodeSourceOptions {
  maxOutputTokens: number;
}

export interface ParsedCodemodeSource {
  code: string;
  options: Partial<CodemodeSourceOptions>;
}

function parseOptions(json: string): Partial<CodemodeSourceOptions> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CodemodeSourceError(
      `${OPTIONS_PREFIX} expects a JSON object, got ${JSON.stringify(json)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CodemodeSourceError(`${OPTIONS_PREFIX} expects a JSON object`);
  }
  const options: Partial<CodemodeSourceOptions> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(SUPPORTED_FIELDS as readonly string[]).includes(key)) {
      throw new CodemodeSourceError(
        `${OPTIONS_PREFIX} does not support ${JSON.stringify(key)}; supported fields are ${SUPPORTED_FIELDS.map((field) => `\`${field}\``).join(" and ")}`,
      );
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new CodemodeSourceError(`${OPTIONS_PREFIX} ${key} must be a positive number`);
    }
    options.maxOutputTokens = value;
  }
  return options;
}

export function parseCodemodeSource(input: string): ParsedCodemodeSource {
  if (input.trim() === "") {
    throw new CodemodeSourceError("Expected JavaScript source text (non-empty).");
  }
  const newline = input.indexOf("\n");
  const firstLine = (newline === -1 ? input : input.slice(0, newline)).replace(/\r$/, "");
  const trimmed = firstLine.trimStart();
  if (!trimmed.startsWith(OPTIONS_PREFIX)) {
    return { code: input, options: {} };
  }
  const code = newline === -1 ? "" : input.slice(newline);
  if (code.trim() === "") {
    throw new CodemodeSourceError(
      "The @options line must be followed by JavaScript source on subsequent lines",
    );
  }
  return { code, options: parseOptions(trimmed.slice(OPTIONS_PREFIX.length).trim()) };
}

/**
 * 只允许「首行可选的 @options + 任意 JS」的 Lark 语法，供支持语法约束采样的 provider
 * 使用（`constrainedSampling`）。
 */
export const CODEMODE_SOURCE_GRAMMAR = String.raw`start: options? source
options: /\/\/ @options: \{[^\n]*\}\n/
source: /(?s:.)+/`;
