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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type BwrapRuntime, createBwrapRuntime } from "../bwrap/runtime.js";
import type { LspManager } from "../lib/lsp/lsp.js";
import { createRequestPolicy, type RequestPolicy } from "../lib/request-policy.js";
import type { ToolBus } from "../lib/tool-bus.js";
import { registerToolsOnSessionStart } from "../lib/tool-registration.js";
import { registerBashTool } from "./bash.js";
import { createOpencodeFileTools } from "./files.js";
import { registerGlobTool } from "./glob.js";
import { registerGrepTool } from "./grep.js";
import { registerQuestionTool } from "./question.js";
import { registerTodoTool } from "./todo.js";

export interface OpencodeToolsetOptions {
  bus?: ToolBus;
  policy?: RequestPolicy;
  runtime?: BwrapRuntime;
  manager?: LspManager;
}

/** opencode 风格工具集的共享部件：入口与独立默认导出都从这里取。 */
export function createOpencodeTools(pi: ExtensionAPI, options?: OpencodeToolsetOptions) {
  // 非沙盒请求策略由本工具集创建，注入文件工具与 bash runtime 共享同一份。
  const policy = options?.policy ?? createRequestPolicy(pi.events);
  const runtime = options?.runtime ?? createBwrapRuntime(policy);
  // 独立入口（不经 src/index.ts 的共享服务）要自己接上 bwrap 的会话钩子与 /bwrap* 命令。
  if (options?.runtime === undefined) {
    runtime.setup(pi);
  }
  const fileTools = createOpencodeFileTools(pi, {
    policy,
    bus: options?.bus,
    manager: options?.manager,
  });

  return {
    fileTools,
    /** 会话启动 / 分支切换时恢复已读记账。 */
    restoreReads(ctx: ExtensionContext): void {
      fileTools.restoreReads(ctx);
    },
    /** 把本工具集的工具注册到总线。 */
    register(bus: ToolBus): void {
      fileTools.register(bus);
      registerGrepTool(bus);
      registerGlobTool(bus);
      registerTodoTool(bus);
      registerQuestionTool(bus);
      registerBashTool(bus, pi, runtime);
    },
  };
}

export default function opencode(pi: ExtensionAPI, options?: { bus?: ToolBus }): void {
  const tools = createOpencodeTools(pi, { bus: options?.bus });

  pi.on("session_start", (_event, ctx) => tools.restoreReads(ctx));
  // rewind / 树内跳转只发 session_tree 不发 session_start，同样要重放当前分支。
  pi.on("session_tree", (_event, ctx) => tools.restoreReads(ctx));

  // 全部工具在同一次 session_start 里注册：禁用规则可以带 models，只有那时
  // 才知道本会话的模型。
  registerToolsOnSessionStart(pi, (bus) => {
    tools.register(bus);
  });
}
