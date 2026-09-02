/**
 * Claude Code 风格 Edit 的字符串匹配工具（移植自真实 Claude Code 的
 * FileEditTool/utils.ts）。
 *
 * - findActualString：先精确匹配，失败则做引号规范化匹配（文件里的花引号
 *   与模型输出的直引号等价），返回文件中的真实文本；
 * - preserveQuoteStyle：当 old_string 通过引号规范化命中时，把 new_string
 *   里的直引号换成文件使用的花引号风格，保持文件的排版一致。
 */

export const LEFT_SINGLE_CURLY_QUOTE = "‘";
export const RIGHT_SINGLE_CURLY_QUOTE = "’";
export const LEFT_DOUBLE_CURLY_QUOTE = "“";
export const RIGHT_DOUBLE_CURLY_QUOTE = "”";

/** 把花引号规范化为直引号（匹配与替换两侧都用它做归一）。 */
export function normalizeQuotes(str: string): string {
  return str
    .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
    .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"');
}

/**
 * 在文件内容中查找与搜索串匹配的实际文本。
 * 先精确匹配；失败则把两侧花引号归一为直引号后重试，返回文件中的原文。
 */
export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) return searchString;
  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    return fileContent.slice(searchIndex, searchIndex + searchString.length);
  }
  return null;
}

/** 引号前是空白/行首/开括号/破折号时视为开引号，否则视为闭引号。 */
function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const prev = chars[index - 1];
  return (
    prev === " " ||
    prev === "\t" ||
    prev === "\n" ||
    prev === "\r" ||
    prev === "(" ||
    prev === "[" ||
    prev === "{" ||
    prev === "\u2014" || // em dash
    prev === "\u2013" // en dash
  );
}

function applyCurlyDoubleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      result.push(isOpeningContext(chars, i) ? LEFT_DOUBLE_CURLY_QUOTE : RIGHT_DOUBLE_CURLY_QUOTE);
    } else {
      result.push(chars[i]);
    }
  }
  return result.join("");
}

function applyCurlySingleQuotes(str: string): string {
  const chars = [...str];
  const result: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // 缩写中的撇号（如 don't）用右花引号，不做开/闭判断
      const prev = i > 0 ? chars[i - 1] : "";
      const next = i + 1 < chars.length ? chars[i + 1] : "";
      const prevIsLetter = /\p{L}/u.test(prev);
      const nextIsLetter = /\p{L}/u.test(next);
      if (prevIsLetter && nextIsLetter) {
        result.push(RIGHT_SINGLE_CURLY_QUOTE);
      } else {
        result.push(
          isOpeningContext(chars, i) ? LEFT_SINGLE_CURLY_QUOTE : RIGHT_SINGLE_CURLY_QUOTE,
        );
      }
    } else {
      result.push(chars[i]);
    }
  }
  return result.join("");
}

/**
 * 当 old_string 通过引号规范化命中（oldString !== actualOldString）时，
 * 把 new_string 中的直引号换成文件实际使用的花引号风格。
 */
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) return newString;
  const hasDoubleQuotes =
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE);
  const hasSingleQuotes =
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE);
  if (!hasDoubleQuotes && !hasSingleQuotes) return newString;

  let result = newString;
  if (hasDoubleQuotes) result = applyCurlyDoubleQuotes(result);
  if (hasSingleQuotes) result = applyCurlySingleQuotes(result);
  return result;
}

/**
 * patch 显示用：把行首 tab 转成 2 空格（对齐 Claude Code 的
 * convertLeadingTabsToSpaces）。仅用于 details 里展示的 diff，不影响写盘内容。
 */
export function convertLeadingTabsToSpaces(content: string): string {
  if (!content.includes("\t")) return content;
  return content.replaceAll(/^\t+/gm, (tabs) => "  ".repeat(tabs.length));
}
