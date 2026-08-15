import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashToolDetails,
  DEFAULT_MAX_BYTES,
  formatSize,
  getAgentDir,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type BwrapRuntime, createBwrapRuntime } from "../bwrap/runtime.js";
import { resolveWorkdir } from "../lib/path.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** 对齐 Claude Code formatError：错误文本超过该长度时头尾各保留一半。 */
const MAX_ERROR_CHARS = 10_000;

/** Bash tool guidance, kept in markdown so it reads like documentation. */
const BASH_PROMPT = readFileSync(fileURLToPath(new URL("bash.md", import.meta.url)), "utf8").trim();

/**
 * 对齐 Claude Code 的错误格式：`Exit code N` 在开头，完整输出随后；
 * 超过 10000 字符时头尾各 5000 + 中间截断提示。
 */
function formatBashError(exitCode: number | null, output: string): string {
  const full = [`Exit code ${exitCode ?? 1}`, output].filter(Boolean).join("\n");
  if (full.length <= MAX_ERROR_CHARS) return full;
  const half = MAX_ERROR_CHARS / 2;
  return (
    full.slice(0, half) +
    `\n\n... [${full.length - MAX_ERROR_CHARS} characters truncated] ...\n\n` +
    full.slice(-half)
  );
}

/**
 * 成功路径：truncateTail 截断 + 全量落盘临时文件，
 * 提示文本 `[Showing lines X-Y of N. Full output: path]`。
 * opencode 套件的 bash 工具复用同一逻辑。
 */
export async function formatBashSuccess(
  output: string,
): Promise<{ content: { type: "text"; text: string }[]; details: BashToolDetails | undefined }> {
  const truncation = truncateTail(output);
  let text = truncation.content || "(no output)";
  let details: BashToolDetails | undefined;
  if (truncation.truncated) {
    // 完整输出落盘到 agent 数据目录的 tmp 子目录（与 pi 的 agent 状态同处，
    // 模型可读；系统临时目录可能被清理）
    const dir = join(getAgentDir(), "tmp");
    await mkdir(dir, { recursive: true });
    const fullOutputPath = join(dir, `${randomUUID()}.txt`);
    await writeFile(fullOutputPath, output, "utf8");
    details = { truncation, fullOutputPath };
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    if (truncation.lastLinePartial) {
      const lastLineSize = formatSize(
        output.length - output.lastIndexOf("\n", output.length - 2) - 1,
      );
      text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${fullOutputPath}]`;
    } else if (truncation.truncatedBy === "lines") {
      text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
    } else {
      text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit). Full output: ${fullOutputPath}]`;
    }
  }
  return { content: [{ type: "text", text }], details };
}

/**
 * runtime 由调用方注入：扩展工厂持有一个实例（不依赖模块级全局状态），
 * 测试可注入预置模式的实例。状态随扩展实例生命周期，session 切换重建即重置。
 */
export function registerShellTools(
  pi: ExtensionAPI,
  runtime: BwrapRuntime = createBwrapRuntime(),
): void {
  runtime.setup(pi);
  pi.registerTool({
    name: "Bash",
    promptSnippet: "execute command",
    promptGuidelines: [`- -\n${BASH_PROMPT}`],
    label: "Bash",
    description: [
      "Executes a given bash command synchronously and returns its output.",
      "timeout is in milliseconds, defaults to 120000, and may not exceed 600000.",
      "Every command runs in the foreground. Background command execution is not supported; shell jobs are waited for before the tool returns.",
    ].join("\n"),
    parameters: Type.Object(
      {
        command: Type.String({ description: "The command to execute" }),
        timeout: Type.Optional(
          Type.Number({ description: "Optional timeout in milliseconds (max 600000)" }),
        ),
        description: Type.Optional(
          Type.String({ description: "Clear, concise description of the command" }),
        ),
        workdir: Type.Optional(
          Type.String({
            description:
              "Working directory to execute the command in. Defaults to the current directory; relative paths resolve from there.",
          }),
        ),
        dangerouslyDisableSandbox: Type.Optional(
          Type.Boolean({
            description:
              "Request one-time unsandboxed execution. The user must approve this request.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, onUpdate, ctx) {
      const timeout = params.timeout ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
        throw new Error(`timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
      }

      const cwd = params.workdir ? await resolveWorkdir(params.workdir, ctx.cwd) : ctx.cwd;

      let result: Awaited<ReturnType<BwrapRuntime["execute"]>>;
      try {
        result = await runtime.execute({
          ctx: { ...ctx, cwd },
          toolCallId: id,
          command: params.command,
          timeout: timeout / 1000,
          requestFullAccess: params.dangerouslyDisableSandbox,
          requestFullAccessReason: params.description,
          signal,
          onUpdate,
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const timeoutMatch = /Command timed out after [\d.]+ seconds/.exec(error.message);
        const message = timeoutMatch
          ? error.message.slice(0, timeoutMatch.index) +
            `Command timed out after ${timeout} milliseconds` +
            error.message.slice(timeoutMatch.index + timeoutMatch[0].length)
          : error.message;
        throw new Error(message, { cause: error });
      }

      // 对齐 Claude Code：非 0 退出码视为错误（不做 grep/find 等命令语义化特判，
      // 任何非 0 都抛错）；成功路径返回纯输出
      if (result.exitCode !== 0 && result.exitCode !== null) {
        throw new Error(formatBashError(result.exitCode, result.output), {
          cause: result,
        });
      }
      return formatBashSuccess(result.output);
    },
  });
}
