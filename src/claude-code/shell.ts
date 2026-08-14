import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

interface MarkerResult {
  text: string;
  cwd: string | undefined;
}

function stripCwdMarker(text: string, marker: string): MarkerResult {
  const match = new RegExp(String.raw`${marker}([^\n]+)${marker}`).exec(text);
  if (!match) return { text, cwd: undefined };
  return { text: text.replace(match[0], "").trimEnd(), cwd: match[1] };
}

function wrapCommand(command: string, marker: string): string {
  return [
    command,
    "__pi_cc_status=$?",
    "wait",
    String.raw`printf '\n${marker}%s${marker}\n' "$PWD"`,
    "exit $__pi_cc_status",
  ].join("\n");
}

export function registerShellTools(pi: ExtensionAPI): void {
  let persistentCwd: string | undefined;

  pi.registerTool({
    name: "Bash",
    label: "Bash",
    description: [
      "Executes a given bash command synchronously and returns its output.",
      "The working directory persists between commands, but shell state does not.",
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
      },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, onUpdate, ctx) {
      const timeout = params.timeout ?? DEFAULT_TIMEOUT_MS;
      if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) {
        throw new Error(`timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`);
      }

      const marker = `__PI_CC_CWD_${id.replaceAll("-", "_")}_${Date.now()}__`;
      const bash = createBashTool(persistentCwd ?? ctx.cwd);
      try {
        const result = await bash.execute(
          id,
          { command: wrapCommand(params.command, marker), timeout: timeout / 1000 },
          signal,
          onUpdate
            ? (update) => {
                const content = update.content.map((item) => {
                  if (item.type !== "text") return item;
                  return { ...item, text: stripCwdMarker(item.text, marker).text };
                });
                onUpdate({ ...update, content });
              }
            : undefined,
        );
        const content = result.content.map((item) => {
          if (item.type !== "text") return item;
          const cleaned = stripCwdMarker(item.text, marker);
          if (cleaned.cwd) persistentCwd = cleaned.cwd;
          return { ...item, text: cleaned.text || "(no output)" };
        });
        return { ...result, content };
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const cleaned = stripCwdMarker(error.message, marker);
        if (cleaned.cwd) persistentCwd = cleaned.cwd;
        const timeoutMatch = /Command timed out after [\d.]+ seconds/.exec(cleaned.text);
        const message = timeoutMatch
          ? cleaned.text.slice(0, timeoutMatch.index) +
            `Command timed out after ${timeout} milliseconds` +
            cleaned.text.slice(timeoutMatch.index + timeoutMatch[0].length)
          : cleaned.text;
        throw new Error(message, { cause: error });
      }
    },
  });
}
