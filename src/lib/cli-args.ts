/**
 * Minimal command-line argument parsing for `/command` handlers.
 *
 * The pi command API passes handlers a raw string (current versions) or a
 * token array (newer ones); this helper accepts either and yields
 * positionals plus flags, so handlers never care about the input shape.
 *
 * A raw string is split with shell-like rules first: whitespace separates
 * tokens, single quotes preserve everything literally, double quotes allow
 * `\"` / `\\` escapes, and a backslash outside quotes escapes the next
 * character. Unlike bash, empty tokens are dropped and an unterminated
 * quote raises a SyntaxError.
 *
 * Flags (only long form, `--name`):
 *   --name value    flag "name" = "value" (value may not start with `--`)
 *   --name=value    same
 *   --flag          boolean flag = true
 *   --              everything after is a positional
 */

export interface ParsedArgs {
  /** Non-flag arguments, in order. */
  positionals: string[];
  /** `--name value` / `--name=value` → string; `--flag` → true. */
  flags: Record<string, string | boolean>;
}

/** Does this token look like a long flag (`--x`, but not the bare `--`)? */
function isFlagToken(token: string): boolean {
  return token.startsWith("--") && token !== "--";
}

/** Shell-like tokenizer for a raw command line. Empty tokens are dropped. */
export function shlexSplit(raw: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: "'" | '"' | undefined;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (quote) {
      if (c === quote) {
        quote = undefined;
      } else if (c === "\\" && quote === '"' && (raw[i + 1] === '"' || raw[i + 1] === "\\")) {
        cur += raw[i + 1];
        i++;
      } else {
        cur += c;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }
    if (c === "\\") {
      if (i + 1 < raw.length) cur += raw[i + 1];
      i += 2;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (quote !== undefined) {
    throw new SyntaxError(`unterminated quote in command arguments: ${raw}`);
  }
  if (cur) tokens.push(cur);
  return tokens;
}

export function parseArgs(input: string | string[]): ParsedArgs {
  const tokens = Array.isArray(input) ? input : shlexSplit(input);
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let positionalOnly = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (positionalOnly) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }
    const m = /^--([a-zA-Z0-9][a-zA-Z0-9-]*)(?:=(.*))?$/.exec(token);
    if (!m) {
      positionals.push(token);
      continue;
    }
    const name = m[1];
    if (m[2] !== undefined) {
      flags[name] = m[2];
      continue;
    }
    // `--name value` form: consume the next token unless it is itself a flag.
    const next = tokens[i + 1];
    if (next !== undefined && !isFlagToken(next)) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}
