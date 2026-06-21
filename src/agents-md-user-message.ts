/**
 * AGENTS.md User Message
 *
 * Moves project-level AGENTS.md from system prompt to user message.
 * Global ~/.pi/agent/AGENTS.md stays in system prompt.
 *
 * Requires --no-context-files to disable pi's default context file loading.
 *
 * Usage:
 *   pi -e ./agents-md-user-message --no-context-files
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let messageInjected = false;

  pi.on("before_agent_start", (event) => {
    const contextFiles = event.systemPromptOptions.contextFiles ?? [];
    if (contextFiles.length > 0) return; // pi already handled them

    // --no-context-files was used, we handle everything
    const files = loadProjectContextFiles({
      cwd: event.systemPromptOptions.cwd,
      agentDir: getAgentDir(),
    });
    if (files.length === 0) return;

    const agentDir = getAgentDir();
    const globalFiles = files.filter((f) => f.path.startsWith(agentDir));
    const projectFiles = files.filter((f) => !f.path.startsWith(agentDir));

    if (projectFiles.length === 0) return;

    let systemPrompt = event.systemPrompt;
    if (globalFiles.length > 0) {
      let block = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
      for (const { path, content } of globalFiles) {
        block += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
      }
      block += "</project_context>\n";
      systemPrompt += block;
    }

    if (!messageInjected) {
      messageInjected = true;

      const content = projectFiles
        .map(
          (f) => `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`,
        )
        .join("\n\n");

      return {
        systemPrompt,
        message: {
          customType: "agents-md-user",
          content,
          display: true,
        },
      };
    }

    return { systemPrompt };
  });

  pi.on("session_shutdown", () => {
    messageInjected = false;
  });
}
