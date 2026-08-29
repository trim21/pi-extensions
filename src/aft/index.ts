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
 * 二进制缺失或 pool 创建失败时降级：不注册任何工具并在 session 开始时报
 * 一次错，而不是让每个工具调用失败。
 *
 * Usage:
 *   pi -e ./aft/index.ts
 */

import { resolveCortexKitConfigPaths } from "@cortexkit/aft-bridge";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { type AftPool, createAftPool, shutdownAftPool } from "./bridge.js";
import { loadAftConfig } from "./config.js";
import { registerImportTool } from "./imports.js";
import { registerRefactorTool } from "./refactor.js";
import {
  registerCallgraphTool,
  registerOutlineTool,
  registerSearchTool,
  registerZoomTool,
} from "./tools.js";

export default async function aftReadTools(pi: ExtensionAPI): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadAftConfig(resolveCortexKitConfigPaths(cwd).userConfigPath);
  if (!cfg.enabled) return;

  let pool: AftPool;
  try {
    pool = await createAftPool(cwd, cfg.semanticRemote);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(
        `AFT tools are disabled: ${message}. Install @cortexkit/aft-<platform> via your npm mirror (locked to the same version as @cortexkit/aft-bridge), then reload.`,
        "error",
      );
    });
    return;
  }

  const toolCtx = { cwd, pool: pool.pool };
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

  // 关闭 bridge pool。session_shutdown 是 pi 的正常生命周期；beforeExit 兜底
  // 进程自然退出（不能注册 SIGINT/SIGTERM——那会吞掉 pi 主进程自己的信号处理）。
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await shutdownAftPool(pool);
    } catch {
      // 关闭失败不影响退出流程
    }
  };
  process.once("beforeExit", () => void shutdown());

  pi.on("session_shutdown", async () => {
    await shutdown();
  });
}
