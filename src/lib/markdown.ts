/**
 * Markdown rendering helpers shared across extensions.
 */

/**
 * Wrap text in a fenced markdown code block.
 *
 * The fence uses one more backtick than the longest backtick run inside the
 * content (min 3), so content containing markdown code fences (```) cannot
 * close the block early and break rendering.
 */
export function fenceCodeBlock(code: string, lang = ""): string {
  const longestRun = Math.max(...(code.match(/`+/g)?.map((match) => match.length) ?? [0]));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${code}\n${fence}`;
}
