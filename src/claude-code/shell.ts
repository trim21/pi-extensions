import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { bwrapRuntime } from "../bwrap/runtime.js";
import { resolveWorkdir } from "../lib/path.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Bash tool guidance, kept in markdown so it reads like documentation. */
const BASH_PROMPT = readFileSync(fileURLToPath(new URL("bash.md", import.meta.url)), "utf8").trim();

export function registerShellTools(pi: ExtensionAPI): void {
  bwrapRuntime.setup(pi);
  pi.registerTool({
    name: "Bash",
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

      try {
        return await bwrapRuntime.execute({
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
    },
  });
}
