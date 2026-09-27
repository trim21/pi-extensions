/**
 * opencode —— 统一注册 opencode 风格工具扩展。
 *
 * 聚合 files（read / edit / write 统一构建，共享 LSP service）、grep /
 * glob（ripgrep 搜索）、todo / question / bash，一次加载全部注册。
 *
 * Usage:
 *   pi -e ./opencode/index.ts
 *
 * spawn-agent 的子代理按声明工具加载 `opencode/files.ts`，`--tools`
 * allowlist 只暴露声明的子集（与 claude-code 三件套映射同一文件一致）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createBwrapRuntime } from "../bwrap/runtime.js";
import { createRequestPolicy } from "../lib/request-policy.js";
import opencodeBash from "./bash.js";
import opencodeFileTools from "./files.js";
import opencodeGlob from "./glob.js";
import opencodeGrep from "./grep.js";
import opencodeQuestion from "./question.js";
import opencodeTodo from "./todo.js";

export default function opencode(pi: ExtensionAPI) {
  // 非沙盒请求策略由本入口创建，注入文件工具与 bash runtime 共享同一份；
  // 独立入口（web/fetch.ts 等）各自创建一份并经 pi.events 保持同步。
  const policy = createRequestPolicy(pi.events);
  opencodeFileTools(pi, { policy });
  opencodeGrep(pi);
  opencodeGlob(pi);
  opencodeTodo(pi);
  opencodeQuestion(pi);
  opencodeBash(pi, createBwrapRuntime(policy));
}
