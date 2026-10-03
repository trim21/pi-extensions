import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, TruncationResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  BashInterruptedError,
  type BwrapRuntime,
  createBwrapRuntime,
  formatElapsedSeconds,
  sandboxHintBlock,
} from "../bwrap/runtime.js";
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  bashStructuredSchema,
  spilledOutput,
} from "../lib/bash-tool.js";
import { resolveWorkdir } from "../lib/path.js";
import { createRequestPolicy } from "../lib/request-policy.js";
import { defineStructuredTool, type ToolBus } from "../lib/tool-bus.js";
import { registerToolsOnSessionStart } from "../lib/tool-registration.js";

/** 对齐上游 opencode 的截断提示文案（tools/BashTool/bash.ts）。 */
const CAPTURE_TRUNCATED_NOTICE = "[output capture truncated at the in-memory safety limit]";

/** Bash tool guidance, kept in markdown so it reads like documentation. */
const BASH_PROMPT = readFileSync(fileURLToPath(new URL("bash.md", import.meta.url)), "utf8").trim();

/** opencode 风格截断提示（成功、超时、中断路径共用）。 */
function appendTruncationNotice(
  text: string,
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
): string {
  if (!truncation.truncated) {
    return text;
  }
  let out = `${text}\n\n${CAPTURE_TRUNCATED_NOTICE}`;
  if (fullOutputPath) {
    out += `\nFull output: ${fullOutputPath}`;
  }
  return out;
}

/**
 * 对齐上游 opencode（packages/core/src/tool/bash.ts）：
 * 命令失败（非 0 退出码）与超时都不抛错，输出与状态文本一起返回，
 * 由模型根据 `Command exited with code N.` 自行判断。
 */
export default function opencodeBash(
  pi: ExtensionAPI,
  runtime: BwrapRuntime = createBwrapRuntime(createRequestPolicy(pi.events)),
): void {
  registerToolsOnSessionStart(pi, (bus) => registerBashTool(bus, pi, runtime));
}

export function registerBashTool(bus: ToolBus, pi: ExtensionAPI, runtime: BwrapRuntime): void {
  bus.register(
    defineStructuredTool({
      name: "bash",
      label: "bash",
      description: [
        "Executes a given bash command synchronously and returns its output.",
        "The default working directory is the current directory; use workdir to run elsewhere.",
        "timeout is in milliseconds, defaults to 120000, and may not exceed 7200000.",
        "Every command runs in the foreground. Background command execution is not supported; shell jobs are waited for before the tool returns.",
      ].join("\n"),
      promptSnippet: "execute bash command",
      promptGuidelines: [BASH_PROMPT],
      parameters: Type.Object(
        {
          command: Type.String({ description: "The command to execute" }),
          description: Type.Optional(
            Type.String({ description: "Clear, concise description of the command" }),
          ),
          workdir: Type.Optional(
            Type.String({
              description:
                "Working directory to execute the command in. Defaults to the current directory; relative paths resolve from there. prefer use this argument over `cd ...`",
            }),
          ),
          timeout: Type.Optional(
            Type.Number({
              description: "Optional timeout in milliseconds (max 7200000)",
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
        const timeout = params.timeout ?? BASH_DEFAULT_TIMEOUT_MS;
        if (!Number.isFinite(timeout) || timeout <= 0 || timeout > BASH_MAX_TIMEOUT_MS) {
          throw new Error(`timeout must be between 1 and ${BASH_MAX_TIMEOUT_MS} milliseconds`);
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
          if (!(error instanceof Error)) {
            throw error;
          }
          if (error instanceof BashInterruptedError) {
            const text = appendTruncationNotice(
              error.partial.output || "",
              error.partial.truncation,
              error.partial.fullOutputPath,
            );
            const status =
              error.kind === "timeout"
                ? `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`
                : `Command aborted by user after ${formatElapsedSeconds(error.elapsedMs)}`;
            const full = text ? `${text}\n\n${status}` : status;
            // 对齐上游 opencode：超时与中断都不抛错，输出与状态文本一起返回；
            // 超时可能是沙箱的网络限制导致的，附加沙箱状态（用户中断与沙箱无关）
            return {
              content: [
                { type: "text" as const, text: full },
                ...sandboxHintBlock(error.kind === "timeout" ? error.sandboxHint : undefined),
                ...sandboxHintBlock(error.sandboxReminder),
              ],
              details: error.kind === "timeout" ? { timeout: true } : {},
              structuredResult: {
                ok: true as const,
                value: {
                  exitCode: null,
                  output: await spilledOutput(
                    error.partial.output,
                    error.partial.truncation,
                    error.partial.fullOutputPath,
                  ),
                },
              },
            };
          }
          throw error;
        }

        // 命令失败（非 0 退出码）不抛错：输出与状态文本一起返回
        let text = result.output || "(no output)";
        text = appendTruncationNotice(text, result.truncation, result.fullOutputPath);
        const failed = result.exitCode !== 0 && result.exitCode !== null;
        return {
          content: [
            { type: "text" as const, text },
            { type: "text" as const, text: `Command exited with code ${result.exitCode}.` },
            // 失败可能是被沙箱的写边界或网络限制挡住的，附一块沙箱状态
            ...sandboxHintBlock(failed ? result.sandboxHint : undefined),
            ...sandboxHintBlock(result.sandboxReminder),
          ],
          details: {
            exitCode: result.exitCode,
            truncated: result.truncation.truncated,
            ...(result.fullOutputPath && { fullOutputPath: result.fullOutputPath }),
          },
          structuredResult: {
            ok: true as const,
            value: {
              exitCode: result.exitCode,
              output: await spilledOutput(result.output, result.truncation, result.fullOutputPath),
            },
          },
        };
      },
      structuredSchema: bashStructuredSchema,
    }),
  );
}
