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
  inlineUserConfigTier,
  readConfigTiers,
  resolveCortexKitConfigPaths,
  resolveCortexKitStorageRoot,
  setActiveLogger,
  timeoutForCommand,
} from "@cortexkit/aft-bridge";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SemanticRemote } from "./config.js";
import { type AftLogger, createAftLogger } from "./logger.js";

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

/** 一次 session 生命周期内的 bridge 状态：日志落盘 + 常驻 aft 子进程。 */
export interface AftState {
  logger: AftLogger;
  pool: AftPool;
}

/** 创建一份 session 级 bridge 状态；日志落在 tmp/{sessionId}/aft-plugin.log。 */
export async function createAftState(
  cwd: string,
  sessionId: string | undefined,
  semantic?: SemanticRemote,
): Promise<AftState> {
  const logger = createAftLogger(sessionId);
  const pool = await createAftPool(cwd, logger, semantic);
  return { logger, pool };
}

/** semantic_search 等待索引构建完成的上限（与 Rust 侧 AFT_WAIT_FOR_SEMANTIC_READY_MS 一致）。 */
export const SEMANTIC_INDEX_WAIT_TIMEOUT_MS = 600_000;

/**
 * 调用图存储未就绪时查询侧的内联等待窗口。Rust 侧默认 0（纯异步：立即返回
 * callgraph_building），非零时查询会在窗口内加入同一个 single-flight 构建，
 * 就绪后直接返回真实结果。窗口必须明显小于 aft-bridge 给 callgraph 的 60s
 * transport 预算，否则客户端先超时并触发 bridge hang 升级。
 */
export const CALLGRAPH_BUILD_WAIT_MS = 30_000;

/**
 * 本扩展替用户注入 embedding 密钥时使用的固定变量名。仅当用户只配了
 * `semantic.api_key`（值）而没配 `semantic.api_key_env`（变量名）时生效。
 */
export const SEMANTIC_API_KEY_ENV = "AFT_SEMANTIC_API_KEY";

/**
 * 创建 transport pool。每个项目根一个常驻 aft 进程，跨 session 共享。
 *
 * `semantic` 决定 embedding 密钥如何送达子进程：aft 只从配置里读 `api_key_env`
 * 这个「变量名」，再自己 `env::var` 取值，所以提供值时必须连带把名字告诉它。
 * 两者都缺省时不注入任何凭据（无鉴权端点直接可用）。
 */
export async function createAftPool(
  cwd: string,
  logger: AftLogger,
  semantic?: SemanticRemote,
): Promise<AftPool> {
  // 必须在任何 bridge 代码运行前注册：不设 logger 时 aft-bridge 会把 child
  // stderr / 生命周期日志 fallback 到 console.error，raw 输出打进 pi 的 stderr 破坏 TUI。
  setActiveLogger(logger);
  const binaryPath = await resolveAftBinary();
  const paths = resolveCortexKitConfigPaths(cwd);
  const childEnv: Record<string, string> = {
    // Rust 侧 semantic_search 在索引 Building 时阻塞等待构建完成
    // （main.rs wait_for_semantic_index_before_search），避免首次搜索拿到
    // 词法 fallback 的部分结果。语义搜索未启用时该逻辑直接跳过。
    AFT_WAIT_FOR_SEMANTIC_READY: "1",
    AFT_WAIT_FOR_SEMANTIC_READY_MS: String(SEMANTIC_INDEX_WAIT_TIMEOUT_MS),
    // 调用图冷构建与 watcher 重建时让查询内联等待就绪，而不是把
    // callgraph_building 直接吐给模型（见 CALLGRAPH_BUILD_WAIT_MS 注释）。
    AFT_CALLGRAPH_BUILD_WAIT_MS: String(CALLGRAPH_BUILD_WAIT_MS),
  };
  const config = [...readConfigTiers(paths)];
  if (semantic?.apiKey !== undefined) {
    // childEnv 叠加在继承的 process.env 之上，所以配置里的值优先于 shell 同名变量。
    // 密钥只进子进程环境，不进日志与工具输出。
    childEnv[semantic.apiKeyEnv ?? SEMANTIC_API_KEY_ENV] = semantic.apiKey;
    if (semantic.apiKeyEnv === undefined) {
      // 用户没指定变量名：追加一份 user tier（后应用的 doc 覆盖先应用的）让 aft
      // 知道该读 SEMANTIC_API_KEY_ENV，否则它不知道去哪个变量取值。
      config.push(
        ...inlineUserConfigTier(
          { semantic: { api_key_env: SEMANTIC_API_KEY_ENV } },
          "pi:semantic-api-key",
        ),
      );
    }
  }
  const pool = await createAftTransportPool({
    harness: "pi",
    binaryPath,
    poolOptions: { childEnv, logger },
    configOverrides: {
      storage_dir: resolveCortexKitStorageRoot(),
      cortexkit_user_config_path: paths.userConfigPath,
      config,
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
