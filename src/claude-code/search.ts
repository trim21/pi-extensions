/**
 * Claude Code style search tools — `Glob` and `Grep`.
 *
 * Aggregation entry that registers both tools; each tool also lives in its own
 * file (glob.ts / grep.ts) so spawn-agent subagents can load them
 * independently via the `Glob` / `Grep` frontmatter tool names.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerGlobTool } from "./glob.js";
import { registerGrepTool } from "./grep.js";

export function registerSearchTools(pi: ExtensionAPI): void {
  registerGlobTool(pi);
  registerGrepTool(pi);
}

// Re-exported for tests and other modules that import pure functions from
// "./search.js"; the implementations live in the split files above.
export { globFiles } from "./glob.js";
export { buildGrepArguments, pageGrepOutput } from "./grep.js";
