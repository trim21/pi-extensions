import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type BwrapRuntime, createBwrapRuntime } from "../bwrap/runtime.js";
import type { LspManager } from "../lib/lsp/lsp.js";
import { createRequestPolicy, type RequestPolicy } from "../lib/request-policy.js";
import type { ToolBus } from "../lib/tool-bus.js";
import { registerToolsOnSessionStart } from "../lib/tool-registration.js";
import { createClaudeCodeFileTools } from "./files.js";
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
export interface ClaudeCodeToolsetOptions {
  bus?: ToolBus;
  policy?: RequestPolicy;
  runtime?: BwrapRuntime;
  manager?: LspManager;
}

/** claude-code 风格工具集的共享部件：入口与独立默认导出都从这里取。 */
export function createClaudeCodeTools(pi: ExtensionAPI, options?: ClaudeCodeToolsetOptions) {
  const policy = options?.policy ?? createRequestPolicy(pi.events);
  const runtime = options?.runtime ?? createBwrapRuntime(policy);
  // 独立入口（不经 src/index.ts 的共享服务）要自己接上 bwrap 的会话钩子与 /bwrap* 命令。
  if (options?.runtime === undefined) {
    runtime.setup(pi);
  }
  const fileTools = createClaudeCodeFileTools(pi, {
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
      registerSearchTools(bus, pi);
      registerShellTools(bus, pi, runtime);
      registerSessionTools(bus, pi);
    },
  };
}

export default function claudeCodeTools(pi: ExtensionAPI, options?: { bus?: ToolBus }): void {
  const tools = createClaudeCodeTools(pi, { bus: options?.bus });

  pi.on("session_start", (_event, ctx) => tools.restoreReads(ctx));
  // rewind / 树内跳转只发 session_tree 不发 session_start，同样要重放当前分支。
  pi.on("session_tree", (_event, ctx) => tools.restoreReads(ctx));

  // 全部工具在同一次 session_start 里注册：禁用规则可以带 models，只有那时
  // 才知道本会话的模型。
  registerToolsOnSessionStart(pi, (bus) => {
    tools.register(bus);
  });
}
