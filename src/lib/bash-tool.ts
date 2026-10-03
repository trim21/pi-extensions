/**
 * claude-code 与 opencode 两套 Bash 工具共用的部分：超时上下限、结构化结果 schema、
 * 以及截断后从落盘文件读回完整输出。
 *
 * 只放两边逐字相同的部分。两套工具的截断提示文案、失败判定与 details 是刻意的差异，
 * 留在各自的工具里，不在这里统一。
 */

import { readFile } from "node:fs/promises";

import type { TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 7_200_000;

/**
 * `Bash` 的结构化结果：只有退出码与完整输出——命令非零退出不是失败，所以载荷里没有成败
 * 标志，脚本直接读 `exitCode` 分支；超时/中止时 `exitCode` 为 `null`（原因在模型侧文本里）。
 */
export const bashStructuredSchema = Type.Object({
  exitCode: Type.Union([Type.Number(), Type.Null()], {
    description: "Exit code of the command; null when it was killed (timeout or abort)",
  }),
  output: Type.String({
    description:
      "Complete output of the command (stdout and stderr merged). Never truncated, never mixed with tool-added notices.",
  }),
});

/**
 * 载荷里的输出：文本被截断时读回落盘的完整输出（读不到就退回那份截断文本），
 * 因此脚本拿到的永远是命令真正输出的内容。
 */
export async function spilledOutput(
  output: string,
  truncation: TruncationResult,
  spillPath: string | undefined,
): Promise<string> {
  if (spillPath === undefined || !truncation.truncated) {
    return output;
  }
  try {
    return await readFile(spillPath, "utf8");
  } catch {
    return output;
  }
}
