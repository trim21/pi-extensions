/**
 * Claude Code 风格的精确替换：只做精确字符串匹配（无模糊策略）。匹配在 CRLF 归一后
 * 进行，写回时恢复原文行尾；new_string 为空且 old_string 不以换行结尾时，连同
 * 紧随其后的换行一起删除，避免留下空行。
 *
 * 只处理非空 `old_string` 的替换：空 `old_string`（创建 / 填充文件）与
 * `old_string === new_string` 的判定在调用方（带工具语义，涉及写盘与提示文案）。
 *
 * 抛错文案是工具契约的一部分（Claude Code 兼容），改动前先看
 * test/claude-code-tools.test.ts 的断言。
 */
export function applyExactEdit(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  // CRLF 规范化后匹配（old_string 不需要带 \r），写回时恢复原行尾
  const crlfCount = (original.match(/\r\n/g) ?? []).length;
  const lfCount = (original.match(/(?<!\r)\n/g) ?? []).length;
  const lineEnding = crlfCount > lfCount ? "\r\n" : "\n";
  const normalized = original.replaceAll("\r\n", "\n");
  const matches = normalized.split(oldString).length - 1;
  if (matches === 0) {
    throw new Error(`String to replace not found in file.\nString: ${oldString}`);
  }
  if (!replaceAll && matches > 1) {
    throw new Error(
      `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`,
    );
  }
  // 删除场景（new_string 为空）：old_string 不以换行结尾且文件里是
  // "old_string\n" 时连换行一起删，避免留下空行（对齐 Claude Code
  // applyEditToFile 的 stripTrailingNewline 语义）
  let searchString = oldString;
  if (newString === "" && !oldString.endsWith("\n") && normalized.includes(oldString + "\n")) {
    searchString = oldString + "\n";
  }
  // split/join 与函数替换：replacement 含 $ 时不会触发 $& 等特殊语义
  const updated = replaceAll
    ? normalized.split(searchString).join(newString)
    : normalized.replace(searchString, () => newString);
  return lineEnding === "\r\n" ? updated.replaceAll("\n", "\r\n") : updated;
}
