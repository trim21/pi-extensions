import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { bwrapRuntime } from "./runtime.js";

export {
  type BwrapConfig,
  resolveBwrap,
  type ResolvedBwrap,
  resolveHeadlessBwrap,
} from "./core.js";
export { type EscalationDecision, resolveEscalation } from "./runtime.js";

export default function bwrapExtension(pi: ExtensionAPI): void {
  bwrapRuntime.setup(pi);
}
