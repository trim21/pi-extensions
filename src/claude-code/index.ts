import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createClaudeCodeState } from "./common.js";
import { registerFileTools } from "./files.js";
import { registerSearchTools } from "./search.js";
import { registerSessionTools } from "./session-tools.js";
import { registerShellTools } from "./shell.js";

export default function claudeCodeTools(pi: ExtensionAPI): void {
  const state = createClaudeCodeState();
  registerFileTools(pi, state);
  registerSearchTools(pi);
  registerShellTools(pi);
  registerSessionTools(pi);
}
