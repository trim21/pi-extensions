/**
 * 本仓库工具注册的配置：`~/.pi/agent/settings.json` 的 `personalExtensions` section。
 *
 * ```jsonc
 * {
 *   "personalExtensions": {
 *     "fileIo": "claude-code",
 *     "fileIoByModel": [{ "models": ["glm-*"], "fileIo": "opencode" }],
 *     "disabledTools": ["talk-*", { "tools": ["web_*"], "models": ["gpt-*"] }],
 *     "enabledTools": [{ "tools": ["web_search"], "models": ["glm-*"] }]
 *   }
 * }
 * ```
 *
 * 工具名与模型名都用 minimatch 通配模式匹配；模型名同时试 `model.id` 与
 * `provider/model` 两种写法。带 `models` 的条目只在当前模型命中时才参与判定。
 * 非法字段/条目被忽略并产出警告，不影响其余配置生效。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import { Type } from "typebox";
import { Value } from "typebox/value";

// ── schema ───────────────────────────────────────────────────────────────────

const fileIoSchema = Type.Union([Type.Literal("claude-code"), Type.Literal("opencode")]);

const fileIoByModelEntrySchema = Type.Object({
  models: Type.Array(Type.String()),
  fileIo: fileIoSchema,
});

const toolRuleSchema = Type.Object({
  tools: Type.Array(Type.String()),
  models: Type.Optional(Type.Array(Type.String())),
});

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type FileIoToolset = "claude-code" | "opencode";

export type ToolRuleField = "disabledTools" | "enabledTools";

export interface FileIoByModelEntry {
  models: readonly string[];
  fileIo: FileIoToolset;
}

export interface ToolPatternRule {
  tools: readonly string[];
  /** 空表示对所有模型生效。 */
  models: readonly string[];
}

export interface ToolsConfig {
  /** 兜底的文件 IO 工具集。 */
  fileIo: FileIoToolset;
  /** 按模型覆盖文件 IO 工具集，按顺序取首条命中。 */
  fileIoByModel: readonly FileIoByModelEntry[];
  disabledTools: readonly ToolPatternRule[];
  enabledTools: readonly ToolPatternRule[];
  /** 解析阶段发现的问题，由调用方在能提示用户时上报。 */
  warnings: readonly string[];
}

export interface ModelIdentity {
  id: string;
  provider?: string;
}

export interface UnmatchedPattern {
  field: ToolRuleField;
  pattern: string;
}

export interface ToolAvailability {
  /** 该工具名是否被禁用（命中 disabledTools 且未命中 enabledTools）。 */
  isDisabled(name: string): boolean;
  /** 哪些模式没匹配到任何工具（含被规则禁用的工具）。 */
  unmatchedPatterns(declaredNames: readonly string[]): UnmatchedPattern[];
}

export const DEFAULT_FILE_IO: FileIoToolset = "claude-code";

// ── 读取与解析 ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFileIo(value: unknown, field: string, warnings: string[]): FileIoToolset | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Value.Check(fileIoSchema, value)) {
    return value;
  }
  warnings.push(
    `${field}: invalid value ${JSON.stringify(value)} ignored (expected "claude-code" or "opencode")`,
  );
  return undefined;
}

function parseFileIoByModel(
  value: unknown,
  field: string,
  warnings: string[],
): FileIoByModelEntry[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`${field}: expected an array, ignored`);
    return [];
  }

  const entries: FileIoByModelEntry[] = [];
  for (const [index, entry] of value.entries()) {
    if (Value.Check(fileIoByModelEntrySchema, entry)) {
      entries.push({ models: [...entry.models], fileIo: entry.fileIo });
      continue;
    }
    warnings.push(
      `${field}[${index}]: invalid entry ignored (expected { models: string[], fileIo: "claude-code" | "opencode" })`,
    );
  }
  return entries;
}

function parseToolRules(value: unknown, fieldPath: string, warnings: string[]): ToolPatternRule[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`${fieldPath}: expected an array, ignored`);
    return [];
  }

  const rules: ToolPatternRule[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "string") {
      rules.push({ tools: [entry], models: [] });
      continue;
    }
    if (Value.Check(toolRuleSchema, entry)) {
      rules.push({ tools: [...entry.tools], models: entry.models ? [...entry.models] : [] });
      continue;
    }
    warnings.push(
      `${fieldPath}[${index}]: invalid entry ignored (expected a tool name pattern or { tools, models })`,
    );
  }
  return rules;
}

/** 解析 `personalExtensions` section（纯函数，便于测试）。 */
export function parseToolsConfig(section: unknown, source = "personalExtensions"): ToolsConfig {
  const warnings: string[] = [];

  if (section === undefined) {
    return {
      fileIo: DEFAULT_FILE_IO,
      fileIoByModel: [],
      disabledTools: [],
      enabledTools: [],
      warnings,
    };
  }
  if (!isRecord(section)) {
    warnings.push(`${source}: expected an object, ignored`);
    return {
      fileIo: DEFAULT_FILE_IO,
      fileIoByModel: [],
      disabledTools: [],
      enabledTools: [],
      warnings,
    };
  }

  return {
    fileIo: parseFileIo(section.fileIo, `${source}.fileIo`, warnings) ?? DEFAULT_FILE_IO,
    fileIoByModel: parseFileIoByModel(section.fileIoByModel, `${source}.fileIoByModel`, warnings),
    disabledTools: parseToolRules(section.disabledTools, `${source}.disabledTools`, warnings),
    enabledTools: parseToolRules(section.enabledTools, `${source}.enabledTools`, warnings),
    warnings,
  };
}

/** 读取全局 settings.json；文件缺失 / 损坏 / 无该 section 时用默认值。 */
export function readToolsConfig(settingsPath = join(getAgentDir(), "settings.json")): ToolsConfig {
  let section: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    section = isRecord(parsed) ? parsed.personalExtensions : undefined;
  } catch {
    return parseToolsConfig(undefined);
  }
  return parseToolsConfig(section);
}

// ── 判定 ─────────────────────────────────────────────────────────────────────

function matchesPattern(pattern: string, value: string): boolean {
  return minimatch(value, pattern);
}

function modelCandidates(model: ModelIdentity | undefined): string[] {
  if (!model) {
    return [];
  }
  return model.provider ? [model.id, `${model.provider}/${model.id}`] : [model.id];
}

function matchesModel(patterns: readonly string[], model: ModelIdentity | undefined): boolean {
  if (patterns.length === 0) {
    return true;
  }
  const candidates = modelCandidates(model);
  return patterns.some((pattern) =>
    candidates.some((candidate) => matchesPattern(pattern, candidate)),
  );
}

function ruleMatches(
  rule: ToolPatternRule,
  name: string,
  model: ModelIdentity | undefined,
): boolean {
  return (
    rule.tools.some((pattern) => matchesPattern(pattern, name)) && matchesModel(rule.models, model)
  );
}

export function resolveFileIoToolset(
  config: ToolsConfig,
  model: ModelIdentity | undefined,
): FileIoToolset {
  for (const entry of config.fileIoByModel) {
    if (matchesModel(entry.models, model)) {
      return entry.fileIo;
    }
  }
  return config.fileIo;
}

export function resolveToolAvailability(
  config: ToolsConfig,
  model: ModelIdentity | undefined,
): ToolAvailability {
  return {
    isDisabled(name) {
      const disabled = config.disabledTools.some((rule) => ruleMatches(rule, name, model));
      if (!disabled) {
        return false;
      }
      return config.enabledTools.every((rule) => !ruleMatches(rule, name, model));
    },

    unmatchedPatterns(declaredNames) {
      const unmatched: UnmatchedPattern[] = [];
      for (const field of ["disabledTools", "enabledTools"] as const) {
        for (const rule of config[field]) {
          for (const pattern of rule.tools) {
            if (declaredNames.every((name) => !matchesPattern(pattern, name))) {
              unmatched.push({ field, pattern });
            }
          }
        }
      }
      return unmatched;
    },
  };
}
