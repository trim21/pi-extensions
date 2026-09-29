/**
 * 工具注册上下文：把「配置 + 当前会话模型 → 总线 → 注册」这条链路收在一处。
 *
 * 约定：模块里的 registerXxx(bus, ...) 只收发工具的总线，需要宿主 API（pi.exec、
 * pi.on、runtime.setup 等）时把 `pi` 作为后续参数显式传入；扩展入口/默认导出
 * 用本文件的 createToolRegistration 把「当前会话模型」接上，并在 session_start
 * 里调用这些 registerXxx。
 *
 * 为什么总线要先建、注册要晚于 `session_start`：
 * - 禁用规则可以带 `models`，只有在 `session_start` 才能拿到本会话的模型，
 *   因此注册发生在 `session_start` 里（总线在加载期先建好，过滤在注册时求值）。
 * - LSP manager 在加载期创建、并在它自己的 `session_start` handler 里启用服务器
 *   后回调注册 lsp 工具，所以它必须在加载期就能拿到同一个总线；模型由本文件
 *   注册的 handler 更新，且它排在所有注册 handler 之前。
 *
 * 注册即启用：`pi.registerTool` 后工具默认进入 active 列表（pi 的 `defaultActive`
 * 语义），本文件不碰 active 列表——工具可见性完全由「注册与否」决定，禁用工具就是
 * 不注册。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createToolBus, type ToolBus } from "./tool-bus.js";
import {
  type ModelIdentity,
  readToolsConfig,
  resolveToolAvailability,
  type ToolsConfig,
  type UnmatchedPattern,
} from "./tools-config.js";

export interface ToolRegistration {
  /** 与同入口其他模块共享的总线。 */
  readonly bus: ToolBus;
  /** 本次配置解析结果（含解析期警告）。 */
  readonly config: ToolsConfig;
  /**
   * 在每次会话启动时注册工具；注册时总线的过滤已按本会话模型生效。回调拿到
   * 本会话的 ctx（reads 记账恢复等需要 sessionManager）。
   */
  onSessionStart(register: (bus: ToolBus, ctx: ExtensionContext) => void | Promise<void>): void;
  /** 哪些配置模式没命中过任何工具（在注册完成后调用）。 */
  unmatchedPatterns(): UnmatchedPattern[];
}

/**
 * 独立入口（按路径加载的模块、或只有一组工具的入口）的注册接线：
 * 每次会话启动时用本会话模型建好的总线注册工具。
 */
export function registerToolsOnSessionStart(
  pi: ExtensionAPI,
  register: (bus: ToolBus, ctx: ExtensionContext) => void | Promise<void>,
): void {
  createToolRegistration(pi).onSessionStart(register);
}

export function createToolRegistration(pi: ExtensionAPI, settingsPath?: string): ToolRegistration {
  const config = readToolsConfig(settingsPath);
  let model: ModelIdentity | undefined;

  const bus = createToolBus(pi, {
    // 每次注册都按当前模型重新判定：工具在 session_start 里注册，模型由下面
    // 的 handler 更新，二者在同一个会话内保持一致。
    isDisabled: (name) => resolveToolAvailability(config, model).isDisabled(name),
  });

  pi.on("session_start", (_event, ctx) => {
    model = ctx.model;
  });

  return {
    bus,
    config,
    onSessionStart(register) {
      pi.on("session_start", async (_event, ctx) => {
        await register(bus, ctx);
      });
    },
    unmatchedPatterns() {
      return resolveToolAvailability(config, model).unmatchedPatterns(bus.declaredNames());
    },
  };
}
