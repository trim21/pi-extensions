/**
 * aft.jsonc 最小读取：只关心 JS 侧注册决策需要的字段（enabled / semantic_search /
 * semantic.backend / semantic.base_url），其余字段由 Rust 侧从配置 tier 自行读取。
 *
 * 只读用户级配置：语义搜索涉及外部 embedding 端点与密钥，按 AFT 的信任边界只允许
 * 用户级控制（项目级配置不应替用户开启语义搜索或注入 base_url）。
 *
 * 本仓库只接受外部 embedding 后端（openai_compatible / ollama）：aft 默认后端
 * fastembed 走本地 ONNX Runtime，内网镜像不提供该运行时，所以即便用户开了
 * semantic_search，外部后端未就绪时也不注册 aft_search。
 *
 * JSONC 解析用微软 jsonc-parser（vscode 同源，处理注释与尾逗号），不手写解析器；
 * 分两层：rawConfigSchema 只描述依赖的外部形状并做基础类型校验，toReadConfig 负责
 * 补默认值与后端语义判定。
 */

import { existsSync, readFileSync } from "node:fs";

import { parse } from "jsonc-parser";
import { type Static, Type } from "typebox";

import { parseWithSchema } from "../lib/parse-with-schema.js";

/** aft 侧走 HTTP embeddings 端点的后端；fastembed（本地 ONNX）有意排除在外。 */
const REMOTE_SEMANTIC_BACKENDS = ["openai_compatible", "ollama"] as const;

export type RemoteSemanticBackend = (typeof REMOTE_SEMANTIC_BACKENDS)[number];

/** 就绪的外部 embedding 后端：类型受支持且配了 base_url。 */
export interface SemanticRemote {
  backend: RemoteSemanticBackend;
  baseUrl: string;
  /**
   * 用户自己指定的密钥环境变量名（可选覆盖）。配了就直接用该名，值由用户的
   * shell 提供，或由 `apiKey` 注入到同名变量。
   */
  apiKeyEnv: string | undefined;
  /**
   * 密钥值（可选）。aft 只认环境变量名，所以未配 `apiKeyEnv` 时由本扩展注入成
   * 固定的内部变量名并告诉 aft 去读它。undefined = 无鉴权端点（自建网关、ollama
   * 都可以不带 key）。
   */
  apiKey: string | undefined;
}

export interface AftReadConfig {
  enabled: boolean;
  semanticSearch: boolean;
  /** undefined = 外部后端未就绪（未配 backend、非远程后端、或缺 base_url）。 */
  semanticRemote: SemanticRemote | undefined;
}

const DEFAULTS: AftReadConfig = {
  enabled: true,
  semanticSearch: false,
  semanticRemote: undefined,
};

/** 上游（aft）控制的形状：只声明本仓库真正读取的字段，未声明的键由解析层忽略。 */
const rawConfigSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  semantic_search: Type.Optional(Type.Boolean()),
  semantic: Type.Optional(
    Type.Object({
      backend: Type.Optional(Type.String()),
      base_url: Type.Optional(Type.String()),
      api_key_env: Type.Optional(Type.String()),
      // 本扩展独有：aft 只读环境变量，密钥值由我们注入成 api_key_env 命名的变量。
      api_key: Type.Optional(Type.String()),
    }),
  ),
});

type RawConfig = Static<typeof rawConfigSchema>;

function isRemoteBackend(value: string): value is RemoteSemanticBackend {
  return (REMOTE_SEMANTIC_BACKENDS as readonly string[]).includes(value);
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function remoteOf(semantic: RawConfig["semantic"]): SemanticRemote | undefined {
  const backend = trimmedOrUndefined(semantic?.backend);
  // 去掉尾斜杠：aft 侧按 base_url + /embeddings 拼请求。
  const baseUrl = trimmedOrUndefined(semantic?.base_url)?.replace(/\/+$/, "");
  if (backend === undefined || baseUrl === undefined) return undefined;
  if (!isRemoteBackend(backend)) return undefined;
  return {
    backend,
    baseUrl,
    apiKeyEnv: trimmedOrUndefined(semantic?.api_key_env),
    apiKey: trimmedOrUndefined(semantic?.api_key),
  };
}

function toReadConfig(raw: RawConfig): AftReadConfig {
  return {
    enabled: raw.enabled ?? DEFAULTS.enabled,
    semanticSearch: raw.semantic_search ?? DEFAULTS.semanticSearch,
    semanticRemote: remoteOf(raw.semantic),
  };
}

/**
 * 读用户级 aft.jsonc。文件缺失、非法 JSONC 或形状不符（含字段类型错误）时整体回退
 * 默认值：注册决策宁可保守，不该因配置写错而让扩展加载失败。
 */
export function loadAftConfig(userConfigPath: string): AftReadConfig {
  try {
    if (!existsSync(userConfigPath)) return DEFAULTS;
    const parsed: unknown = parse(readFileSync(userConfigPath, "utf8"));
    return toReadConfig(parseWithSchema(rawConfigSchema, parsed ?? {}));
  } catch {
    return DEFAULTS;
  }
}
