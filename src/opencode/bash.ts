import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type BwrapRuntime, createBwrapRuntime } from "../bwrap/runtime.js";
import { resolveWorkdir } from "../lib/path.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** 对齐上游 opencode 的截断提示文案（tools/BashTool/bash.ts）。 */
const CAPTURE_TRUNCATED_NOTICE = "[output capture truncated at the in-memory safety limit]";

/**
 * 对齐上游 opencode（packages/core/src/tool/bash.ts）：
 * 命令失败（非 0 退出码）与超时都不抛错，输出与状态文本一起返回，
 * 由模型根据 `Command exited with code N.` 自行判断。
 */
export default function opencodeBash(
  pi: ExtensionAPI,
  runtime: BwrapRuntime = createBwrapRuntime(),
): void {
  // 每个扩展实例持有自己的 runtime：不依赖模块级全局状态，状态随扩展
  // 实例生命周期（进程启动 / /reload / session 切换时工厂重建即重置）。
  runtime.setup(pi);
  pi.registerTool({
    name: "bash",
    label: "bash",
    description: [
      "Executes a given bash command synchronously and returns its output.",
      "The default working directory is the current directory; use workdir to run elsewhere.",
      "timeout is in milliseconds, defaults to 120000, and may not exceed 600000.",
      "Every command runs in the foreground. Background command execution is not supported; shell jobs are waited for before the tool returns.",
    ].join("\n"),
    promptSnippet: "execute bash command",
    parameters: Type.Object(
      {
        command: Type.String({ description: "The command to execute" }),
        workdir: Type.Optional(
          Type.String({
            description:
              "Working directory to execute the command in. Defaults to the current directory; relative paths resolve from there. prefer use this argument over `cd ...`",
          }),
        ),
        timeout: Type.Optional(
          Type.Number({
            description: "Optional timeout in milliseconds (max 600000)",
            default: 600,
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
          signal,
          onUpdate,
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        // 对齐上游 opencode：超时不抛错，返回提示文本（丢弃部分输出）
        if (/Command timed out after [\d.]+ seconds/.test(error.message)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Command exceeded timeout of ${timeout} ms. Retry with a larger timeout if the command is expected to take longer.`,
              },
              { type: "text" as const, text: "Command timed out before completion." },
            ],
            details: { timeout: true },
          };
        }
        throw error;
      }

      // 命令失败（非 0 退出码）不抛错：输出与状态文本一起返回
      let text = result.output || "(no output)";
      if (result.truncation.truncated) {
        text += `\n\n${CAPTURE_TRUNCATED_NOTICE}`;
        if (result.fullOutputPath) text += `\nFull output: ${result.fullOutputPath}`;
      }
      return {
        content: [
          { type: "text" as const, text },
          { type: "text" as const, text: `Command exited with code ${result.exitCode}.` },
        ],
        details: {
          exitCode: result.exitCode,
          truncated: result.truncation.truncated,
          ...(result.fullOutputPath && { fullOutputPath: result.fullOutputPath }),
        },
      };
    },
  });
}
