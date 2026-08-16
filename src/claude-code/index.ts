import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import claudeCodeFileTools from "./files.js";
import { registerSearchTools } from "./search.js";
import { registerSessionTools } from "./session-tools.js";
import { registerShellTools } from "./shell.js";

/**
 * Claude Code 风格工具集入口：聚合 files / search / shell / session 四组工具。
 *
 * reads state 的创建与 session 恢复归 files.ts 所有（见其 default export），
 * 本文件不再持有 state；spawn-agent 子代理按工具名直接 `-e` 加载各模块文件
 * （files.ts / grep.ts / glob.ts 均为独立扩展入口）。
 */
export default function claudeCodeTools(pi: ExtensionAPI): void {
  claudeCodeFileTools(pi);
  registerSearchTools(pi);
  registerShellTools(pi);
  registerSessionTools(pi);
}
