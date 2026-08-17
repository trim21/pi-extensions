/**
 * aft.jsonc 最小读取：只关心 JS 侧注册决策需要的字段
 * （enabled / semantic_search），完整配置由 Rust 侧从配置 tier 读取。
 *
 * 只读用户级配置：semantic_search 涉及外部 embedding 后端，按 AFT 的信任
 * 边界语义只允许用户级控制（项目级配置不应替用户开启语义搜索）。
 *
 * JSONC 解析用微软 jsonc-parser（vscode 同源，处理注释与尾逗号），
 * 不手写解析器。
 */

import { existsSync, readFileSync } from "node:fs";

import { parse } from "jsonc-parser";

export interface AftReadConfig {
  enabled: boolean;
  semanticSearch: boolean;
}

const DEFAULTS: AftReadConfig = { enabled: true, semanticSearch: false };

function readOne(path: string): AftReadConfig {
  try {
    if (!existsSync(path)) return DEFAULTS;
    const parsed: unknown = parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return DEFAULTS;
    }
    const value = parsed as Record<string, unknown>;
    return {
      enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
      semanticSearch:
        typeof value.semantic_search === "boolean"
          ? value.semantic_search
          : DEFAULTS.semanticSearch,
    };
  } catch {
    return DEFAULTS;
  }
}

/** 读用户级 aft.jsonc。解析失败或文件缺失时回退默认值（不阻塞扩展加载）。 */
export function loadAftConfig(userConfigPath: string): AftReadConfig {
  return readOne(userConfigPath);
}
