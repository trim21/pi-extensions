import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type ClaudeCodeState, createClaudeCodeState, deserializeReads } from "./common.js";
import { registerFileTools } from "./files.js";
import { registerSearchTools } from "./search.js";
import { registerSessionTools } from "./session-tools.js";
import { registerShellTools } from "./shell.js";

/** 会更新 reads state 并随 details 持久化快照的工具名。 */
const FILE_TOOL_NAMES = new Set(["Read", "Edit", "Write"]);

/**
 * 从当前分支的历史工具结果重建已读记账。先清空再重放，保证 state 只反映
 * 当前分支：rewind / fork / resume 后，被抛弃分支上的 Read 不再残留。
 */
function restoreReads(
  state: ClaudeCodeState,
  sessionManager: ExtensionContext["sessionManager"],
): void {
  state.reads.clear();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (!FILE_TOOL_NAMES.has(entry.message.toolName)) continue;
    const details = entry.message.details as { reads?: unknown } | undefined;
    if (!details?.reads) continue;
    for (const [filePath, snapshot] of deserializeReads(details.reads)) {
      state.reads.set(filePath, snapshot);
    }
  }
}

export default function claudeCodeTools(pi: ExtensionAPI): void {
  const state = createClaudeCodeState();

  // 扩展实例在进程启动 / /reload / /new / /resume / /fork 时重建，内存里的
  // 已读记账随之丢失。这里从当前分支的历史工具结果里恢复：digest 是当时的值，
  // 若文件在此期间被外部修改，Edit/Write 时的指纹对比仍会要求重新 Read，
  // 防呆语义不因重建而弱化。
  pi.on("session_start", (_event, ctx) => {
    restoreReads(state, ctx.sessionManager);
  });

  // rewind / 树内跳转走 navigateTree → branch()，只发 session_tree 不发
  // session_start，扩展实例也不重建。这里同样重放当前分支，丢弃被抛弃分支
  // 的记账，避免 state 与当前分支脱节。
  pi.on("session_tree", (_event, ctx) => {
    restoreReads(state, ctx.sessionManager);
  });

  registerFileTools(pi, state);
  registerSearchTools(pi);
  registerShellTools(pi);
  registerSessionTools(pi);
}
