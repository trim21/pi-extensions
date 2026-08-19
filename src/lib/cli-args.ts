/**
 * Shell-like tokenizer for `/command` handlers.
 *
 * The pi command API passes handlers a raw string (current versions) or a
 * token array (newer ones); `shlexSplit` turns the raw string into tokens:
 * whitespace separates tokens, single quotes preserve everything literally,
 * double quotes allow `\"` / `\\` escapes, and a backslash outside quotes
 * escapes the next character. Unlike bash, empty tokens are dropped and an
 * unterminated quote raises a SyntaxError.
 */

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
