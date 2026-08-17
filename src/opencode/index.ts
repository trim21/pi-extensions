/**
 * opencode —— 统一注册 opencode 风格工具扩展。
 *
 * 聚合 files（read / edit / write 统一构建，共享 LSP service）、todo /
 * question / bash，一次加载全部注册；各工具的公开 API（匹配引擎、纯函数等）
 * 也从这里重新导出，方便测试与其他模块（如 lib/write-guard）引用。
 *
 * Usage:
 *   pi -e ./opencode/index.ts
 *
 * spawn-agent 的子代理按声明工具加载 `opencode/files.ts`，`--tools`
 * allowlist 只暴露声明的子集（与 claude-code 三件套映射同一文件一致）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import opencodeBash from "./bash.js";
import opencodeFileTools from "./files.js";
import opencodeQuestion from "./question.js";
import opencodeTodo from "./todo.js";

export { default as opencodeBash } from "./bash.js";
export {
  detectLineEnding,
  normalizeForEdit,
  normalizeToLF,
  replace,
  restoreLineEndings,
  stripBom,
} from "./edit-engine.js";
export {
  default as opencodeFileTools,
  resolveBom,
  truncateHead,
  type TruncationResult,
} from "./files.js";
export { default as opencodeQuestion } from "./question.js";
export { default as opencodeTodo } from "./todo.js";

export default function opencode(pi: ExtensionAPI) {
  opencodeFileTools(pi);
  opencodeTodo(pi);
  opencodeQuestion(pi);
  opencodeBash(pi);
}
