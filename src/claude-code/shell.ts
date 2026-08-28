import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  type BashToolDetails,
  type ExtensionAPI,
  formatSize,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { BashInterruptedError, type BwrapRuntime, createBwrapRuntime } from "../bwrap/runtime.js";
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

/** 输出被截断时附加的 `[Showing lines...]` 提示（成功、超时、中断路径共用）。 */
function appendTruncationNotice(
  text: string,
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
): string {
  if (!fullOutputPath || !truncation.truncated) return text;
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    const lastLineSize = formatSize(text.length - text.lastIndexOf("\n", text.length - 2) - 1);
    return `${text}\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${fullOutputPath}]`;
  }
  if (truncation.truncatedBy === "lines") {
    return `${text}\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${fullOutputPath}]`;
  }
  return `${text}\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes)} limit). Full output: ${fullOutputPath}]`;
}

/**
 * 成功路径：消费 runtime 的截断结果（输出已由 runtime 截断并落盘），
 * 截断时追加 `[Showing lines X-Y of N. Full output: path]` 提示。
 * opencode 套件的 bash 工具复用同一逻辑。
 */
export function formatBashSuccess(result: Awaited<ReturnType<BwrapRuntime["execute"]>>): {
  content: { type: "text"; text: string }[];
  details: BashToolDetails | undefined;
} {
  const { output, truncation, fullOutputPath } = result;
  const text = appendTruncationNotice(output || "(no output)", truncation, fullOutputPath);
  return {
    content: [{ type: "text", text }],
    details: fullOutputPath && truncation.truncated ? { truncation, fullOutputPath } : undefined,
  };
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
    promptGuidelines: [BASH_PROMPT],
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
          ctx,
          cwd,
          toolCallId: id,
          command: params.command,
          timeout: timeout / 1000,
          requestFullAccess: params.dangerouslyDisableSandbox,
          description: params.description,
          signal,
          onUpdate,
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (error instanceof BashInterruptedError) {
          // 输出在前（必要时带截断提示），状态文本在最后
          const text = appendTruncationNotice(
            error.partial.output || "",
            error.partial.truncation,
            error.partial.fullOutputPath,
          );
          if (error.kind === "aborted") {
            // 用户取消：直接返回已捕获的输出，不抛错
            const full = text ? `${text}\n\nCommand aborted` : "Command aborted";
            return { content: [{ type: "text", text: full }], details: undefined };
          }
          const full = text
            ? `${text}\n\nCommand timed out after ${timeout} milliseconds`
            : `Command timed out after ${timeout} milliseconds`;
          throw new Error(full, { cause: error });
        }
        throw error;
      }

      // 对齐 Claude Code：非 0 退出码视为错误（不做 grep/find 等命令语义化特判，
      // 任何非 0 都抛错）；错误文本用完整输出（从落盘文件读取，必要时头尾截断）
      if (result.exitCode !== 0 && result.exitCode !== null) {
        const full = result.fullOutputPath
          ? await readFile(result.fullOutputPath, "utf8")
          : result.output;
        throw new Error(formatBashError(result.exitCode, full), {
          cause: result,
        });
      }
      return formatBashSuccess(result);
    },
  });
}
