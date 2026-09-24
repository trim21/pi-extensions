/**
 * Claude Code 风格 Edit 的展示辅助。
 *
 * 上游 Claude Code 还带一套引号规范化（花引号与直引号互相等价匹配，并把
 * new_string 改写成文件的花引号风格），这里刻意没有移植：它无法用语言语法
 * 判断两个引号是否语义等价（markdown 里 `'` 与 `’` 就是两个字符），而且会
 * 替模型改写它没有写的字符。Edit 只做精确匹配。
 */

/**
 * patch 显示用：把行首 tab 转成 2 空格（对齐 Claude Code 的
 * convertLeadingTabsToSpaces）。仅用于 details 里展示的 diff，不影响写盘内容。
 */
export function convertLeadingTabsToSpaces(content: string): string {
  if (!content.includes("\t")) {
    return content;
  }
  return content.replaceAll(/^\t+/gm, (tabs) => "  ".repeat(tabs.length));
}
