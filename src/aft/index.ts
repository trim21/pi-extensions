/**
 * AFT 扩展入口：感知工具（aft_outline / aft_zoom / aft_callgraph / aft_search），
 * 全部只读。
 *
 * 感知工具不触碰本仓库自己的 read/write/edit/bash 工具及其安全机制
 * （bwrap 沙箱、write-guard、reads 记账）。aft_search 仅当用户级 aft.jsonc 开启
 * semantic_search 且配好外部 embedding 后端（semantic.backend 为
 * openai_compatible / ollama 且有 base_url）时注册；aft 默认的本地 ONNX
 * fastembed 后端不使用。
 *
 * bridge 状态（日志 + 常驻 aft 子进程）的生命周期跟 session 走：session_start
 * 时先解析 aft 二进制（含 GitHub release auto-download 兜底）——找不到就
 * notify warning 且不注册任何 aft 工具，避免模型看到只会抛 "not initialized"
 * 的死工具；找到则注册工具并创建 bridge 状态（日志落在
 * tmp/{sessionId}/aft-plugin.log），session_shutdown / 进程退出时释放。
 * 工具实现经 getState() 取状态。
 *
 * Usage:
 *   pi -e ./aft/index.ts
 */

import { resolveCortexKitConfigPaths } from "@cortexkit/aft-bridge";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ToolBus } from "../lib/tool-bus.js";
import { registerToolsOnSessionStart } from "../lib/tool-registration.js";
import { createAftState, findBinary, resolveSessionId, shutdownAftPool } from "./bridge.js";
import { loadAftConfig } from "./config.js";
import {
  registerCallgraphTool,
  registerOutlineTool,
  registerSearchTool,
  registerZoomTool,
} from "./tools.js";

/**
 * aft 工具集：入口用它。`registerForSession` 必须在会话启动时调用——二进制
 * 探测、semantic_search 的提示、bridge 状态的创建都在里面；找不到二进制就不
 * 注册任何工具（避免模型看到只会抛 "not initialized" 的死工具）。
 */
export function createAftTools(pi: ExtensionAPI): {
  registerForSession(bus: ToolBus, ctx: ExtensionContext): Promise<void>;
} {
  const cwd = process.cwd();
  const cfg = loadAftConfig(resolveCortexKitConfigPaths(cwd).userConfigPath);
  // bridge 状态跟 session 生命周期走，作用域就是本工厂闭包，不落到模块级。
  let state: Awaited<ReturnType<typeof createAftState>> | null = null;

  const getState = (): Awaited<ReturnType<typeof createAftState>> => {
    if (!state) {
      throw new Error(
        "AFT is not initialized for this session (no session_start event has fired yet)",
      );
    }
    return state;
  };

  const toolCtx = { cwd, getState };

  async function registerForSession(bus: ToolBus, ctx: ExtensionContext): Promise<void> {
    if (!cfg.enabled) {
      return;
    }

    const binaryPath = await findBinary();
    if (!binaryPath) {
      ctx.ui.notify(
        "AFT binary not found: aft_outline / aft_zoom / aft_callgraph are not registered. " +
          "Install the npm platform package (@cortexkit/aft-<platform>), run `cargo install agent-file-tools`, " +
          "or place `aft` on PATH, then restart pi.",
        "warning",
      );
      return;
    }

    // 只开了 semantic_search 开关、没配外部 embedding 后端：与其静默不注册，
    // 不如说明缺什么。
    if (cfg.semanticSearch && !cfg.semanticRemote) {
      ctx.ui.notify(
        "aft_search is not registered: semantic_search needs an external embedding backend (aft.jsonc semantic.backend = openai_compatible | ollama, plus base_url). The local ONNX fastembed default is not used here.",
        "warning",
      );
    }

    // 先注册工具再建 bridge 状态：状态构建失败（如 bridge 起不来）时工具仍然
    // 可见，错误按原样浮出给用户，而不是变成「工具消失」。
    registerOutlineTool(bus, toolCtx);
    registerZoomTool(bus, toolCtx);
    registerCallgraphTool(bus, toolCtx);
    if (cfg.semanticSearch && cfg.semanticRemote) {
      registerSearchTool(bus, toolCtx);
    }

    state = await createAftState(cwd, resolveSessionId(ctx), binaryPath, cfg.semanticRemote);
  }

  // 释放当前 session 的 bridge 状态。session_shutdown 是 pi 的正常生命周期；
  // beforeExit 兜底进程自然退出（不能注册 SIGINT/SIGTERM——那会吞掉 pi 主进程
  // 自己的信号处理）。释放后下个 session_start 用新 session id 重建。
  const shutdown = async (): Promise<void> => {
    const current = state;
    state = null;
    if (!current) {
      return;
    }
    try {
      await shutdownAftPool(current.pool);
      await current.logger.drain();
    } catch {
      // 释放失败不影响退出流程
    }
  };
  process.once("beforeExit", () => void shutdown());

  pi.on("session_shutdown", async () => {
    await shutdown();
  });

  return { registerForSession };
}

export default function aftReadTools(pi: ExtensionAPI): void {
  const tools = createAftTools(pi);
  registerToolsOnSessionStart(pi, (bus, ctx) => tools.registerForSession(bus, ctx));
}
