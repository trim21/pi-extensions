/**
 * opencode —— 统一注册 opencode 风格工具扩展。
 *
 * 聚合 read / edit / write / todo / question 五个工具，一次加载全部注册；
 * 各工具的公开 API（匹配引擎、纯函数等）也从这里重新导出，方便
 * 测试与其他模块（如 workspace-guard）引用。
 *
 * Usage:
 *   pi -e ./opencode/index.ts
 *
 * spawn-agent 的子代理按声明工具单独加载 `opencode/{read,edit,write}.ts`，
 * 避免把未声明的工具注入子代理工具集。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import opencodeEdit from "./edit.js";
import opencodeQuestion from "./question.js";
import opencodeRead from "./read.js";
import opencodeTodo from "./todo.js";
import opencodeWrite from "./write.js";

export { default as opencodeEdit } from "./edit.js";
export {
  detectLineEnding,
  normalizeForEdit,
  normalizeToLF,
  replace,
  restoreLineEndings,
  stripBom,
} from "./edit-engine.js";
export { default as opencodeQuestion } from "./question.js";
export { default as opencodeRead, truncateHead, type TruncationResult } from "./read.js";
export { default as opencodeTodo } from "./todo.js";
export { default as opencodeWrite, resolveBom } from "./write.js";

export default function opencode(pi: ExtensionAPI) {
  opencodeRead(pi);
  opencodeEdit(pi);
  opencodeWrite(pi);
  opencodeTodo(pi);
  opencodeQuestion(pi);
}
