import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { bwrapRuntime } from "./runtime.js";

export {
  type BwrapConfig,
  resolveBwrap,
  type ResolvedBwrap,
  resolveHeadlessBwrap,
} from "./core.js";
export { type EscalationDecision, resolveEscalation } from "./runtime.js";

const sandboxedBashSchema = Type.Object(
  {
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    request_full_access: Type.Optional(
      Type.Boolean({
        description:
          "Set true to request unsandboxed execution. The bwrap runtime will ask the user for approval.",
      }),
    ),
    request_full_access_reason: Type.Optional(
      Type.String({ description: "Explain why unsandboxed execution is required." }),
    ),
  },
  { additionalProperties: false },
);

export default function bwrapExtension(pi: ExtensionAPI): void {
  bwrapRuntime.setup(pi);
  const localBash = createBashTool(process.cwd());
  pi.registerTool({
    name: localBash.name,
    label: "bash (bwrap)",
    description:
      localBash.description +
      "\n\nSet request_full_access to true to request unsandboxed execution.",
    parameters: sandboxedBashSchema,
    executionMode: localBash.executionMode,
    execute(id, params, signal, onUpdate, ctx) {
      return bwrapRuntime.execute({
        toolCallId: id,
        command: params.command,
        timeout: params.timeout,
        requestFullAccess: params.request_full_access,
        requestFullAccessReason: params.request_full_access_reason,
        signal,
        onUpdate,
        ctx,
      });
    },
  });
}
