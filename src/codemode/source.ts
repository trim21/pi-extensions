/**
 * codemode 脚本源码的解析：首行可选的 `// @options: {"max_output_tokens":…, "timeout_ms":…}`。
 *
 * 选项行与脚本首行共用一行，解析后原样保留为空行，脚本里报错的行号因此与用户写的
 * 一致。解析失败（空输入、JSON 非法、未知字段、只有选项行没有代码）直接报错。
 */

const OPTIONS_PREFIX = "// @options:";
const SUPPORTED_FIELDS = ["max_output_tokens", "timeout_ms"] as const;

/** `timeout_ms` 的上限：`setTimeout` 能接受的最大延时（毫秒）。 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export const DEFAULT_OUTPUT_TOKENS = 10_000;

export class CodemodeSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodemodeSourceError";
  }
}

export interface CodemodeSourceOptions {
  maxOutputTokens: number;
  /** 本次执行的墙钟预算（毫秒）。不声明时脚本没有时间上限。 */
  timeoutMs: number;
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
    if (key === "timeout_ms") {
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > MAX_TIMEOUT_MS
      ) {
        throw new CodemodeSourceError(
          `${OPTIONS_PREFIX} \`timeout_ms\` must be a positive integer up to ${MAX_TIMEOUT_MS}`,
        );
      }
      options.timeoutMs = value;
      continue;
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
