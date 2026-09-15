import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBwrapRuntime } from "../bwrap/runtime.js";
import { createRequestPolicy } from "../lib/request-policy.js";
import claudeCodeFileTools from "./files.js";
import { registerSearchTools } from "./search.js";
import { registerSessionTools } from "./session-tools.js";
import { registerShellTools } from "./shell.js";

/**
 * Claude Code 风格工具集入口：聚合 files / search / shell / session 四组工具。
 *
 * reads state 的创建与 session 恢复归 files.ts 所有（见其 default export），
 * 非沙盒请求策略（Read/Edit/Write/lsp-rename 的工作区外写入与 Bash 的
 * `dangerouslyDisableSandbox` 共用）由本文件创建后注入两侧；spawn-agent
 * 子代理按工具名直接 `-e` 加载各模块文件（files.ts / grep.ts / glob.ts 均为
 * 独立扩展入口），那些入口各自创建一份策略并经 pi.events 保持同步。
 */
export default function claudeCodeTools(pi: ExtensionAPI): void {
  const policy = createRequestPolicy(pi.events);
  claudeCodeFileTools(pi, { policy });
  registerSearchTools(pi);
  registerShellTools(pi, createBwrapRuntime(policy));
  registerSessionTools(pi);
}
