/**
 * AFT 扩展入口：感知工具（aft_outline / aft_zoom / aft_callgraph / aft_search）
 * + aft_refactor / aft_import（workspace-wide 重构与 import 管理，路径级写保护）。
 *
 * 感知工具只读，不触碰本仓库自己的 read/write/edit/bash 工具及其安全机制
 * （bwrap 沙箱、write-guard、reads 记账）。aft_search 仅当用户级 aft.jsonc 开启
 * semantic_search 且配好外部 embedding 后端（semantic.backend 为
 * openai_compatible / ollama 且有 base_url）时注册；aft 默认的本地 ONNX
 * fastembed 后端不使用。aft_refactor / aft_import 的 Rust 命令不支持 preview，
 * 写保护退化为路径级审批。
 *
 * bridge 状态（日志 + 常驻 aft 子进程）的生命周期跟 session 走：session_start
 * 时用当次 session id 创建（日志落在 tmp/{sessionId}/aft-plugin.log），
 * session_shutdown / 进程退出时释放。工具实现经 getState() 取状态，
 * session 未初始化时抛错。
 *
 * Usage:
 *   pi -e ./aft/index.ts
 */

import { resolveCortexKitConfigPaths } from "@cortexkit/aft-bridge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createAftState, resolveSessionId, shutdownAftPool } from "./bridge.js";
import { loadAftConfig } from "./config.js";
import { registerImportTool } from "./imports.js";
import { registerRefactorTool } from "./refactor.js";
import {
  registerCallgraphTool,
  registerOutlineTool,
  registerSearchTool,
  registerZoomTool,
} from "./tools.js";

export default function aftReadTools(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const cfg = loadAftConfig(resolveCortexKitConfigPaths(cwd).userConfigPath);
  if (!cfg.enabled) return;

  // bridge 状态跟 session 生命周期走，作用域就是本工厂闭包，不落到模块级。
  let state: Awaited<ReturnType<typeof createAftState>> | null = null;

  // 预热：提前解析二进制并拉起 bridge 子进程；失败直接抛给 pi（runner 捕获
  // 后上报 ExtensionError），工具调用侧经 getState() 抛未初始化错误。
  pi.on("session_start", async (_event, ctx) => {
    state = await createAftState(cwd, resolveSessionId(ctx), cfg.semanticRemote);
  });

  const getState = (): Awaited<ReturnType<typeof createAftState>> => {
    if (!state) {
      throw new Error(
        "AFT is not initialized for this session (no session_start event has fired yet)",
      );
    }
    return state;
  };

  const toolCtx = { cwd, getState };
  registerOutlineTool(pi, toolCtx);
  registerZoomTool(pi, toolCtx);
  registerCallgraphTool(pi, toolCtx);
  registerRefactorTool(pi, toolCtx);
  registerImportTool(pi, toolCtx);
  if (cfg.semanticSearch) {
    if (cfg.semanticRemote) {
      registerSearchTool(pi, toolCtx);
    } else {
      // 只开了开关、没配外部 embedding 后端：与其静默不注册，不如说明缺什么。
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.notify(
          "aft_search is not registered: semantic_search needs an external embedding backend (aft.jsonc semantic.backend = openai_compatible | ollama, plus base_url). The local ONNX fastembed default is not used here.",
          "warning",
        );
      });
    }
  }

  // 释放当前 session 的 bridge 状态。session_shutdown 是 pi 的正常生命周期；
  // beforeExit 兜底进程自然退出（不能注册 SIGINT/SIGTERM——那会吞掉 pi 主进程
  // 自己的信号处理）。释放后下个 session_start 用新 session id 重建。
  const shutdown = async (): Promise<void> => {
    const current = state;
    state = null;
    if (!current) return;
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
}
