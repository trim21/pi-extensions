/**
 * 配置驱动的 LSP 服务器：一份 JSON 配置定义一个语言服务器（bin/args/rootMarkers/
 * languageId/超时等），替代为每个语言写一个 adapter class。
 *
 * 配置文件沿用 lsp.json（全局 ~/.pi/agent/lsp.json + 本地 <cwd>/.pi/lsp.json）：
 * 顶层 `servers` 是 id → 配置的 record，全局与本地按 id 合并（同名 id 整体
 * 覆盖、新增 id、全局其余保留），之后受顶层 enabled/disabled 列表过滤。
 * 没有内置默认服务器：未配置 servers 时不启动任何服务器。
 *
 * executable 发现统一由用户配置：bin 支持绝对路径 / 项目工作区
 * （node_modules/.bin、.venv/bin、venv/bin）/ PATH，不再内置各语言的
 * 特殊探测逻辑（tsserver 路径、venv python 等）。
 */

import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { minimatch } from "minimatch";
import { type Static, Type } from "typebox";

import {
  type LspServerAdapter,
  type LspServerHandle,
  nearestRoot,
  type ServerKind,
} from "./adapter.js";
import { exists, findBinaryInWorkspace, which } from "./bin.js";
import { spawnProcess } from "./launch.js";

export const serverConfigSchema = Type.Object({
  /** 文件 glob（相对项目根或调用 cwd，任一命中即可）；缺省匹配所有文件。 */
  include: Type.Optional(Type.Array(Type.String())),
  /** 服务器类型：language（真语言服务器，缺省）或 linter（只实现 LSP 协议的 lint）。 */
  kind: Type.Optional(Type.Union([Type.Literal("language"), Type.Literal("linter")])),
  /** 项目根标记文件（从文件目录向上查找）；缺省用调用 cwd 作为根。 */
  rootMarkers: Type.Optional(Type.Array(Type.String())),
  /** 可执行文件：绝对路径、相对调用 cwd 的路径，或名字（项目工作区优先，PATH 兜底）。 */
  bin: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  /** 启动工作目录，支持 {root} / {cwd} 模板；缺省 {root}。 */
  cwd: Type.Optional(Type.String()),
  /**
   * 追加到子进程的环境变量。string 值支持 {root} / {cwd} 模板与 ${VAR} 引用；
   * {sh: [...]} 在启动时执行命令（argv 直接执行、不经 shell），stdout trim 后作为值，
   * 失败（非零退出 / 空输出）时服务器启动失败并报错。
   */
  env: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Object({ sh: Type.Array(Type.String()) })]),
    ),
  ),
  /** 文件扩展名（含点）→ LSP languageId，didOpen 用；缺省回退内置映射表。 */
  languageIdByExtension: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** initialize 握手超时（ms）；缺省用全局配置 / client 默认。 */
  startupTimeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
  /** 写文件后等待诊断的时长（ms）；缺省用全局配置 / client 默认。 */
  diagnosticsWaitMs: Type.Optional(Type.Number({ minimum: 1 })),
  /** initialize 请求的 initializationOptions；字符串值支持 ${VAR} / ${VAR:-default} 插值。 */
  initializationOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** didChangeConfiguration / workspace/configuration 请求的 settings。 */
  settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type ServerConfig = Static<typeof serverConfigSchema>;

/** 按 id 合并 servers record：同名 id 整体覆盖（不做逐字段 merge），其余保留；返回 undefined 表示没有任何 servers 定义。 */
export function mergeServerRecords(
  ...records: (Readonly<Record<string, ServerConfig>> | undefined)[]
): Record<string, ServerConfig> | undefined {
  const merged: Record<string, ServerConfig> = {};
  for (const record of records) {
    if (!record) continue;
    Object.assign(merged, record);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** 组装启用的服务器列表：全部来自用户配置 servers（id → 配置），无内置默认。 */
export function createAdapters(
  userServers?: Readonly<Record<string, ServerConfig>>,
): LspServerAdapter[] {
  return Object.entries(userServers ?? {}).map(([id, config]) => new ConfigAdapter(id, config));
}

/** {root} / {cwd} 模板替换（bin / cwd 字段均支持）。 */
function resolveTemplate(template: string, root: string, cwd: string): string {
  return template.split("{root}").join(root).split("{cwd}").join(cwd);
}

/** ${VAR} / ${VAR:-default} 插值；shell 语义：未定义或空时用 default（缺省空字符串）。 */
const envVarPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

function interpolateEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replaceAll(envVarPattern, (_match, name: string, fallback?: string) => {
    const resolved = env[name];
    return resolved !== undefined && resolved !== "" ? resolved : (fallback ?? "");
  });
}

/** 深遍历配置值，对所有字符串做环境变量插值。 */
function interpolateEnvDeep(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return interpolateEnvVars(value, env);
  if (Array.isArray(value)) return value.map((item) => interpolateEnvDeep(item, env));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateEnvDeep(item, env)]),
    );
  }
  return value;
}

/** 解析 per-server env：string 值做 {root} / {cwd} 模板 + 环境变量引用插值，{sh} 执行命令取 stdout。 */
async function resolveEnv(
  config: Record<string, string | { sh: string[] }> | undefined,
  root: string,
  cwd: string,
): Promise<NodeJS.ProcessEnv | undefined> {
  const entries = Object.entries(config ?? {});
  if (entries.length === 0) return undefined;
  const resolved = await Promise.all(
    entries.map(async ([key, value]): Promise<[string, string]> => {
      if (typeof value === "string") {
        return [key, interpolateEnvVars(resolveTemplate(value, root, cwd), process.env)];
      }
      return [key, await runEnvCommand(value.sh, cwd)];
    }),
  );
  return Object.fromEntries(resolved);
}

const execFile = promisify(nodeExecFile);

/**
 * argv 直接执行（不经 shell，避免注入面；需要 shell 特性时配置里自行包
 * ["bash", "-c", "..."]），stdout trim 后作为 env 值。
 * 失败（spawn 错误 / 非零退出 / 空输出）时抛错，由 lsp.ts 捕获后 notify 给用户。
 */
async function runEnvCommand(argv: string[], cwd: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(argv[0], argv.slice(1), { cwd }));
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    const reason = typeof err.code === "number" ? `exit code ${err.code}` : err.message;
    const stderr = err.stderr?.trim();
    throw new Error(
      `env command failed (${argv.join(" ")}): ${reason}${stderr ? `: ${stderr}` : ""}`,
      { cause: error },
    );
  }
  const output = stdout.trim();
  if (!output) {
    throw new Error(`env command (${argv.join(" ")}) produced empty output`);
  }
  return output;
}

/** 解析可执行文件：绝对/相对路径直接用；名字走项目工作区（node_modules/.bin 等）→ PATH。 */
async function resolveBinary(bin: string, root: string, cwd: string): Promise<string | undefined> {
  if (isAbsolute(bin)) return existsSync(bin) ? bin : undefined;
  if (bin.includes("/") || bin.includes("\\")) {
    const relativePath = join(cwd, bin);
    return exists(relativePath) ? relativePath : undefined;
  }
  return (await findBinaryInWorkspace(bin, root, cwd)) ?? which(bin);
}

/**
 * include glob 匹配：相对项目根或调用 cwd 的路径，任一命中即可。
 * 支持 `!` 否定模式排除；多 pattern 数组拆开判断（任意 positive 命中且
 * 不被任何 negative 排除），避免库对混合数组的语义差异。
 */
function matchesInclude(
  patterns: readonly string[],
  file: string,
  root: string,
  cwd: string,
): boolean {
  if (patterns.length === 0) return true;
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) negatives.push(pattern.slice(1));
    else positives.push(pattern);
  }
  if (positives.length === 0) positives.push("**");
  const candidates = [relative(root, file), relative(cwd, file)]
    .map((p) => p.split(sep).join("/"))
    .filter((p) => !p.startsWith(".."));
  const matches = (candidate: string): boolean =>
    positives.some((pattern) => minimatch(candidate, pattern)) &&
    negatives.every((pattern) => !minimatch(candidate, pattern));
  return candidates.some((candidate) => matches(candidate));
}

/** 由配置构建的通用 adapter；include 精确过滤在 findRoot 完成，extensions 不设扩展名过滤。 */
export class ConfigAdapter implements LspServerAdapter {
  readonly id: string;
  readonly kind: ServerKind;
  readonly extensions: readonly string[] = [];
  readonly startupTimeoutMs: number | undefined;
  readonly diagnosticsWaitMs: number | undefined;
  readonly config: ServerConfig;

  constructor(id: string, config: ServerConfig) {
    this.id = id;
    this.config = config;
    this.kind = config.kind ?? "language";
    this.startupTimeoutMs = config.startupTimeoutMs;
    this.diagnosticsWaitMs = config.diagnosticsWaitMs;
  }

  findRoot(file: string, cwd: string): Promise<string | undefined> {
    const root = nearestRoot(this.config.rootMarkers ?? [], file, cwd);
    return root.then((resolved) =>
      matchesInclude(this.config.include ?? [], file, resolved, cwd) ? resolved : undefined,
    );
  }

  async spawn(root: string, cwd: string): Promise<LspServerHandle | undefined> {
    const bin = this.config.bin;
    if (!bin) return undefined;
    const resolved = await resolveBinary(bin, root, cwd);
    if (!resolved) return undefined;
    const spawnCwd = resolveTemplate(this.config.cwd ?? "{root}", root, cwd);
    const env = await resolveEnv(this.config.env, root, cwd);
    return {
      process: spawnProcess(resolved, this.config.args ?? [], {
        cwd: spawnCwd,
        env,
      }),
      initialization: interpolateEnvDeep(this.config.initializationOptions, {
        ...process.env,
        ...env,
      }) as Record<string, unknown> | undefined,
      settings: this.config.settings,
      languageIds: this.config.languageIdByExtension,
    };
  }
}
