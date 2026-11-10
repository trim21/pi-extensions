/**
 * 本仓库工具注册的配置：`~/.pi/agent/settings.json` 的 `personalExtensions` section。
 *
 * ```jsonc
 * {
 *   "personalExtensions": {
 *     "fileIo": "claude-code",
 *     "fileIoByModel": [{ "models": ["glm-*"], "fileIo": "opencode" }],
 *     "fileIoReadTracking": false,
 *     "disabledTools": ["talk-*", { "tools": ["web_*"], "models": ["gpt-*"] }],
 *     "enabledTools": [{ "tools": ["web_search"], "models": ["glm-*"] }],
 *     "codemodeOnlyTools": [{ "tools": ["read-github-*"], "models": ["glm-*"] }],
 *     "shell": { "env": { "GIT_EDITOR": "true", "GIT_SEQUENCE_EDITOR": "true" } }
 *   }
 * }
 * ```
 *
 * 工具名与模型名都用 minimatch 通配模式匹配；模型名同时试 `model.id` 与
 * `provider/model` 两种写法。带 `models` 的条目只在当前模型命中时才参与判定。
 * 非法字段/条目被忽略并产出警告，不影响其余配置生效。
 *
 * `codemodeOnlyTools` 只表示曝光方式：命中它的工具由总线决定是否按 codemode-only
 * 注册（还要看工具有没有声明 `structuredSchema`，见 `tool-bus.ts`）。
 *
 * `fileIoReadTracking` 只控制文件 IO 工具集的 read-before-write 记账（已读快照、
 * 读后未变校验、`details.reads` 回放），不影响 `fileIo` / `fileIoByModel` 选哪套
 * 工具集。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { isRecord } from "./narrow.js";
import { parseWithSchema } from "./parse-with-schema.js";

// ── schema ───────────────────────────────────────────────────────────────────

export const DEFAULT_FILE_IO: FileIoToolset = "claude-code";

/** 文件 IO 工具集的取值。 */
const fileIoSchema = Type.Union([Type.Literal("claude-code"), Type.Literal("opencode")]);

/** `fileIoByModel` 的一条：命中 `models` 时改用 `fileIo` 那套工具集。 */
const fileIoByModelEntrySchema = Type.Object({
  models: Type.Array(Type.String()),
  fileIo: fileIoSchema,
});

/** 一条工具规则：工具名模式字符串，或 `{ tools, models? }`。 */
const toolRuleSchema = Type.Union([
  Type.String(),
  Type.Object({
    tools: Type.Array(Type.String()),
    models: Type.Optional(Type.Array(Type.String())),
  }),
]);

/**
 * 整个 `personalExtensions` section 的形状与默认值。字段都不带 `Type.Optional`：
 * 缺省值由 schema 上的 `default` 给，解析时先 `Value.Default` 补齐再校验，因此
 * 解析结果里的每个字段都是确定有值的。
 */
const toolsConfigSchema = Type.Object({
  fileIo: Type.Union([Type.Literal("claude-code"), Type.Literal("opencode")], {
    default: DEFAULT_FILE_IO,
  }),
  fileIoByModel: Type.Array(fileIoByModelEntrySchema, { default: [] }),
  fileIoReadTracking: Type.Boolean({ default: true }),
  disabledTools: Type.Array(toolRuleSchema, { default: [] }),
  enabledTools: Type.Array(toolRuleSchema, { default: [] }),
  codemodeOnlyTools: Type.Array(toolRuleSchema, { default: [] }),
  shell: Type.Object(
    /** `shell.env`：环境变量名 → 值，注入给 bash 工具执行的命令。 */
    { env: Type.Record(Type.String(), Type.String(), { default: {} }) },
    { default: { env: {} } },
  ),
});

/** section 补齐默认值并校验后的形状。 */
type ToolsConfigSection = Static<typeof toolsConfigSchema>;

// ── 类型 ─────────────────────────────────────────────────────────────────────

export type FileIoToolset = "claude-code" | "opencode";

export type ToolRuleField = "disabledTools" | "enabledTools" | "codemodeOnlyTools";

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
  /** 文件 IO 工具集是否维护 read-before-write 记账（已读快照、读后未变校验、details.reads 回放）。 */
  fileIoReadTracking: boolean;
  disabledTools: readonly ToolPatternRule[];
  enabledTools: readonly ToolPatternRule[];
  /** 命中且声明了 `structuredSchema` 的工具只进 codemode、不交给 pi。 */
  codemodeOnlyTools: readonly ToolPatternRule[];
  /** `shell.env`：注入给 bash 命令的额外环境变量（沙箱内外都生效）。 */
  shellEnv: Readonly<Record<string, string>>;
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
  /** 该工具名是否命中 codemodeOnlyTools（是否真的按 codemode-only 注册还要看它有没有结构化输出）。 */
  isCodemodeOnly(name: string): boolean;
  /** 哪些模式没匹配到任何工具（含被规则禁用的工具）。 */
  unmatchedPatterns(declaredNames: readonly string[]): UnmatchedPattern[];
}

// ── 读取与解析 ───────────────────────────────────────────────────────────────

/** parseWithSchema 的 message 是 `字段路径: 说明`；在根本身上的路径前缀没有信息量。 */
function failureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^\(root\): /, "");
}

/** 补齐 schema 上的默认值再校验；结果里每个字段都确定有值。 */
function parseSection(value: unknown): ToolsConfigSection {
  return parseWithSchema(toolsConfigSchema, Value.Default(toolsConfigSchema, value));
}

/** 解析单个字段：非法值推一条带字段路径与取值的警告，返回 undefined 让默认值生效。 */
function parseField<T extends TSchema>(
  schema: T,
  value: unknown,
  path: string,
  warnings: string[],
): Static<T> | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return parseWithSchema(schema, value);
  } catch (error) {
    warnings.push(
      `${path}: invalid value ${JSON.stringify(value)} ignored (${failureDetail(error)})`,
    );
    return undefined;
  }
}

/** 逐条解析数组字段：单条非法只丢这一条，其余条目照常生效。 */
function parseEntries<T extends TSchema>(
  schema: T,
  value: unknown,
  path: string,
  warnings: string[],
): Static<T>[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`${path}: expected an array, ignored`);
    return [];
  }

  const entries: Static<T>[] = [];
  for (const [index, entry] of value.entries()) {
    try {
      entries.push(parseWithSchema(schema, entry));
    } catch (error) {
      warnings.push(`${path}[${index}]: invalid entry ignored (${failureDetail(error)})`);
    }
  }
  return entries;
}

/** 解析 `shell.env`：非法条目逐键告警并跳过，其余键照常生效。 */
function parseShellEnv(value: unknown, path: string, warnings: string[]): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    warnings.push(`${path}: expected an object mapping names to string values, ignored`);
    return {};
  }

  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parseField(Type.String(), entry, `${path}.${key}`, warnings);
    if (parsed !== undefined) {
      env[key] = parsed;
    }
  }
  return env;
}

/** 解析 `shell` section：目前只有 `env`。 */
function parseShellSection(
  value: unknown,
  path: string,
  warnings: string[],
): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    warnings.push(`${path}: expected an object, ignored`);
    return {};
  }
  return parseShellEnv(value.env, `${path}.env`, warnings);
}

function toToolRule(entry: Static<typeof toolRuleSchema>): ToolPatternRule {
  return typeof entry === "string"
    ? { tools: [entry], models: [] }
    : { tools: [...entry.tools], models: entry.models ? [...entry.models] : [] };
}

/** 解析结果 → 配置：只做归一化，默认值与校验都在 schema 那一侧。 */
function toToolsConfig(section: ToolsConfigSection, warnings: readonly string[]): ToolsConfig {
  return {
    fileIo: section.fileIo,
    fileIoByModel: section.fileIoByModel.map((entry) => ({
      models: [...entry.models],
      fileIo: entry.fileIo,
    })),
    fileIoReadTracking: section.fileIoReadTracking,
    disabledTools: section.disabledTools.map((entry) => toToolRule(entry)),
    enabledTools: section.enabledTools.map((entry) => toToolRule(entry)),
    codemodeOnlyTools: section.codemodeOnlyTools.map((entry) => toToolRule(entry)),
    shellEnv: { ...section.shell.env },
    warnings,
  };
}

/**
 * 整段合法时一次 `parseSection` 就够；出现非法条目才逐字段 / 逐条目降级，
 * 让其余配置照常生效。
 */
function parseTolerantly(
  section: Record<string, unknown>,
  source: string,
  warnings: string[],
): ToolsConfigSection {
  try {
    return parseSection(section);
  } catch {
    // 具体哪一项非法由下面的降级解析逐条报告。
  }

  const valid: Record<string, unknown> = {};

  const fileIo = parseField(
    toolsConfigSchema.properties.fileIo,
    section.fileIo,
    `${source}.fileIo`,
    warnings,
  );
  if (fileIo !== undefined) {
    valid.fileIo = fileIo;
  }

  if (section.fileIoByModel !== undefined) {
    valid.fileIoByModel = parseEntries(
      fileIoByModelEntrySchema,
      section.fileIoByModel,
      `${source}.fileIoByModel`,
      warnings,
    );
  }

  const fileIoReadTracking = parseField(
    toolsConfigSchema.properties.fileIoReadTracking,
    section.fileIoReadTracking,
    `${source}.fileIoReadTracking`,
    warnings,
  );
  if (fileIoReadTracking !== undefined) {
    valid.fileIoReadTracking = fileIoReadTracking;
  }

  for (const field of ["disabledTools", "enabledTools", "codemodeOnlyTools"] as const) {
    if (section[field] !== undefined) {
      valid[field] = parseEntries(toolRuleSchema, section[field], `${source}.${field}`, warnings);
    }
  }

  if (section.shell !== undefined) {
    valid.shell = { env: parseShellSection(section.shell, `${source}.shell`, warnings) };
  }

  return parseSection(valid);
}

/** 解析 `personalExtensions` section（纯函数，便于测试）。 */
export function parseToolsConfig(section: unknown, source = "personalExtensions"): ToolsConfig {
  const warnings: string[] = [];

  if (section === undefined) {
    return toToolsConfig(parseSection({}), warnings);
  }
  if (!isRecord(section)) {
    warnings.push(`${source}: expected an object, ignored`);
    return toToolsConfig(parseSection({}), warnings);
  }

  return toToolsConfig(parseTolerantly(section, source, warnings), warnings);
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

    isCodemodeOnly(name) {
      return config.codemodeOnlyTools.some((rule) => ruleMatches(rule, name, model));
    },

    unmatchedPatterns(declaredNames) {
      const unmatched: UnmatchedPattern[] = [];
      for (const field of ["disabledTools", "enabledTools", "codemodeOnlyTools"] as const) {
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
