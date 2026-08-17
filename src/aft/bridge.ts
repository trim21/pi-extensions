/**
 * AFT bridge 管理：二进制解析、transport pool 生命周期、工具调用封装。
 *
 * 依赖 @cortexkit/aft-bridge（官方协议的 JS 客户端）：findBinary 的解析顺序是
 * 缓存 → npm 平台包（@cortexkit/aft-<platform>，随 npm 镜像分发，无运行时网络）
 * → PATH → cargo → GitHub release 兜底；内网部署只要保证平台包版本与
 * aft-bridge 锁一致就不会走到最后的网络下载。
 */

import {
  type AftProjectTransport,
  type AftTransportPool,
  type BridgeRequestOptions,
  createAftTransportPool,
  findBinary,
  readConfigTiers,
  resolveCortexKitConfigPaths,
  resolveCortexKitStorageRoot,
  timeoutForCommand,
} from "@cortexkit/aft-bridge";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Pi 会话 ID：Rust 侧用它做 session 作用域（undo/checkpoint），感知工具可留空。 */
export function resolveSessionId(extCtx: ExtensionContext): string | undefined {
  const manager = (extCtx as unknown as { sessionManager?: { getSessionId?: () => string } })
    .sessionManager;
  const id = manager?.getSessionId?.();
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * 解析 aft 二进制；失败时抛出（调用方决定是否降级不注册工具）。
 * 不带版本参数：findBinary 内部用 @cortexkit/aft-bridge 自身版本作为匹配基准，
 * 与 npm 平台包（@cortexkit/aft-<platform>）精确对齐，避免手动读 package.json
 * （其 exports 不暴露 ./package.json）。
 */
export async function resolveAftBinary(): Promise<string> {
  const path = await findBinary();
  if (!path) {
    throw new Error(
      "AFT binary not found. Install via npm platform package (@cortexkit/aft-<platform>), cargo install agent-file-tools, or place `aft` on PATH.",
    );
  }
  return path;
}

export interface AftPool {
  pool: AftTransportPool;
  /** 当前项目根（process.cwd），供 bridge 查询。 */
  projectRoot: string;
}

/** 创建 transport pool。每个项目根一个常驻 aft 进程，跨 session 共享。 */
export async function createAftPool(cwd: string): Promise<AftPool> {
  const binaryPath = await resolveAftBinary();
  const paths = resolveCortexKitConfigPaths(cwd);
  const pool = await createAftTransportPool({
    harness: "pi",
    binaryPath,
    poolOptions: {},
    configOverrides: {
      storage_dir: resolveCortexKitStorageRoot(),
      cortexkit_user_config_path: paths.userConfigPath,
      config: readConfigTiers(paths),
    },
  });
  pool.setConfigureOverride("harness", "pi");
  return { pool, projectRoot: cwd };
}

/**
 * 调用 AFT 工具命令并返回 Rust 格式化好的文本。
 * 只读感知工具统一走 toolCall（server 侧 tool_call 分派）。`softCodes` 里的
 * 错误码（如 symbol_not_found）是合法否定答案，不抛错、按文本返回。
 */
export async function callAftTool(
  bridge: AftProjectTransport,
  command: string,
  rawArgs: Record<string, unknown>,
  extCtx: ExtensionContext,
  options?: BridgeRequestOptions & { preview?: boolean },
  softCodes?: ReadonlySet<string>,
): Promise<{ text: string; response: Record<string, unknown> }> {
  const timeoutMs = timeoutForCommand(command);
  const sessionId = resolveSessionId(extCtx);
  const sendOptions = {
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...options,
  };
  const response = await bridge.toolCall(
    sessionId,
    command,
    rawArgs,
    Object.keys(sendOptions).length > 0 ? sendOptions : undefined,
  );
  if (!response.success) {
    const code = typeof response.code === "string" ? response.code : "";
    if (softCodes?.has(code)) {
      return {
        text: response.text || response.message || "",
        response: response as unknown as Record<string, unknown>,
      };
    }
    throw new Error(response.text || response.message || `${command} failed`);
  }
  return {
    text: typeof response.text === "string" ? response.text : "",
    response: response as unknown as Record<string, unknown>,
  };
}

/** 关闭 pool（session 结束 / 进程退出时调用）。 */
export async function shutdownAftPool(owner: AftPool): Promise<void> {
  await owner.pool.shutdown();
}
