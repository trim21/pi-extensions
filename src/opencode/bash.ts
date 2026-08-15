import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type BwrapRuntime, createBwrapRuntime } from "../bwrap/runtime.js";
import { formatBashSuccess } from "../claude-code/shell.js";
import { resolveWorkdir } from "../lib/path.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

export default function opencodeBash(pi: ExtensionAPI): void {
  // 每个扩展实例持有自己的 runtime：不依赖模块级全局状态，状态随扩展
  // 实例生命周期（进程启动 / /reload / session 切换时工厂重建即重置）。
  const runtime = createBwrapRuntime();
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
              "Working directory to execute the command in. Defaults to the current directory; relative paths resolve from there.",
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
        const timeoutMatch = /Command timed out after [\d.]+ seconds/.exec(error.message);
        const message = timeoutMatch
          ? error.message.slice(0, timeoutMatch.index) +
            `Command timed out after ${timeout} milliseconds` +
            error.message.slice(timeoutMatch.index + timeoutMatch[0].length)
          : error.message;
        throw new Error(message, { cause: error });
      }

      // 任何非 0 退出码都视为失败（不做命令语义化特判）
      if (result.exitCode !== 0 && result.exitCode !== null) {
        const status = `Command exited with code ${result.exitCode}`;
        throw new Error(result.output ? `${result.output}\n\n${status}` : status, {
          cause: result,
        });
      }
      return formatBashSuccess(result.output);
    },
  });
}
