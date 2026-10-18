/**
 * 用 git 计算监听范围内被整体忽略的目录。
 *
 * 不解析 gitignore 语法：`ls-files --others --ignored --exclude-standard
 * --directory` 的输出就是 git 自己判定的“整个被忽略的目录”（尾随 `/`），
 * 自动覆盖嵌套 `.gitignore`、`.git/info/exclude`、全局 excludesFile 与取反
 * 规则。目录名只会是 POSIX 相对路径，交给 `@parcel/watcher` 做绝对路径前缀
 * 排除，因此不需要转成 glob。
 *
 * 非 git 仓库、git 不可用、扫描失败或超时一律返回空集合：gitignore 过滤是
 * 优化路径，失败时监听器退回内置忽略。
 */

import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

/** 扫描上限：大仓库遍历不应拖住监听器启动。 */
const GIT_TIMEOUT_MS = 3_000;
/** 被忽略文件极多时 `-z` 输出可能很大；超出视为失败并退回内置忽略。 */
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

/** 目录名含这些字符时 `@parcel/watcher` 会把路径当 glob，跳过该目录。 */
const GLOB_METACHARACTERS = /[*?[\]{}()!]/;

/** 返回 root 内被 git 整体忽略的目录（POSIX 相对路径，不含尾随 `/`）。 */
export async function gitignoredDirectories(root: string): Promise<string[]> {
  let stdout: string;
  try {
    const result = await execFile(
      "git",
      ["-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }
  return stdout
    .split("\0")
    .filter((entry) => entry.endsWith("/"))
    .map((entry) => entry.slice(0, -1))
    .filter((entry) => entry.length > 0 && !GLOB_METACHARACTERS.test(entry));
}
