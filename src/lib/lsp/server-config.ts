/**
 * 配置驱动的 LSP 服务器：一份 JSON 配置定义一个语言服务器（bin/args/rootMarkers/
 * languageId/超时等），替代为每个语言写一个 adapter class。
 *
 * 配置文件沿用 lsp.json（全局 ~/.pi/agent/lsp.json + 本地 <cwd>/.pi/lsp.json）：
 * 顶层 `servers` 是 id → 配置的 record，按 id 与内置默认服务器合并
 * （同名 id 整体覆盖、新增 id、enabled:false 禁用），之后仍受现有
 * enabled/disabled 白名单过滤。
 *
 * executable 发现统一由用户配置：bin 支持绝对路径 / 项目工作区
 * （node_modules/.bin、.venv/bin、venv/bin）/ PATH，不再内置各语言的
 * 特殊探测逻辑（tsserver 路径、venv python 等）。
 */

import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import { minimatch } from "minimatch";
import { type Static, Type } from "typebox";

import { type LspServerAdapter, type LspServerHandle, nearestRoot } from "./adapter.js";
import { exists, findBinaryInWorkspace, which } from "./bin.js";
import { spawnProcess } from "./launch.js";

export const serverConfigSchema = Type.Object({
  /** false = 从启用集中移除（覆盖同名内置服务器）；缺省启用。 */
  enabled: Type.Optional(Type.Boolean()),
  /** 文件 glob（相对项目根或调用 cwd，任一命中即可）；缺省匹配所有文件。 */
  include: Type.Optional(Type.Array(Type.String())),
  /** 项目根标记文件（从文件目录向上查找）；缺省用调用 cwd 作为根。 */
  rootMarkers: Type.Optional(Type.Array(Type.String())),
  /** 可执行文件：绝对路径、相对调用 cwd 的路径，或名字（项目工作区优先，PATH 兜底）。 */
  bin: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  /** 启动工作目录，支持 {root} / {cwd} 模板；缺省 {root}。 */
  cwd: Type.Optional(Type.String()),
  /** 文件扩展名（含点）→ LSP languageId，didOpen 用；缺省回退内置映射表。 */
  languageIdByExtension: Type.Optional(Type.Record(Type.String(), Type.String())),
  /** initialize 握手超时（ms）；缺省用全局配置 / client 默认。 */
  startupTimeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
  /** 写文件后等待诊断的时长（ms）；缺省用全局配置 / client 默认。 */
  diagnosticsWaitMs: Type.Optional(Type.Number({ minimum: 1 })),
  /** initialize 请求的 initializationOptions。 */
  initializationOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** didChangeConfiguration / workspace/configuration 请求的 settings。 */
  settings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type ServerConfig = Static<typeof serverConfigSchema>;

/** 内置默认服务器（id → 配置，可被用户配置按 id 覆盖，全量字段均可配置化表达）。 */
export const defaultServers: Record<string, ServerConfig> = {
  typescript: {
    include: ["**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"],
    rootMarkers: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"],
    bin: "typescript-language-server",
    args: ["--stdio"],
    cwd: "{root}",
    languageIdByExtension: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".mts": "typescript",
      ".cts": "typescript",
    },
  },
  pyright: {
    include: ["**/*.py", "**/*.pyi"],
    rootMarkers: [
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "Pipfile",
      "pyrightconfig.json",
    ],
    bin: "pyright-langserver",
    args: ["--stdio"],
    cwd: "{root}",
    languageIdByExtension: { ".py": "python", ".pyi": "python" },
  },
  ruff: {
    include: ["**/*.py", "**/*.pyi"],
    rootMarkers: ["pyproject.toml", "ruff.toml", ".ruff.toml"],
    bin: "ruff",
    args: ["server"],
    cwd: "{root}",
    languageIdByExtension: { ".py": "python", ".pyi": "python" },
  },
  clangd: {
    include: ["**/*.{c,h,cpp,hpp,cc,cxx,c++,hh,hxx,h++}"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd"],
    bin: "clangd",
    args: ["--background-index", "--clang-tidy"],
    cwd: "{root}",
    languageIdByExtension: {
      ".c": "c",
      ".h": "c",
      ".cpp": "cpp",
      ".hpp": "cpp",
      ".cc": "cpp",
      ".cxx": "cpp",
      ".c++": "cpp",
      ".hh": "cpp",
      ".hxx": "cpp",
      ".h++": "cpp",
    },
  },
};

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

/** 用户 servers（id → 配置）与默认配置合并：同名 id 整体覆盖、新增 id、enabled:false 移除。 */
export function mergeServerConfigs(
  defaults: Readonly<Record<string, ServerConfig>>,
  user: Readonly<Record<string, ServerConfig>> | undefined,
): Record<string, ServerConfig> {
  if (!user) return { ...defaults };
  const merged = { ...defaults };
  for (const [id, server] of Object.entries(user)) {
    if (server.enabled === false) {
      delete merged[id];
      continue;
    }
    merged[id] = server;
  }
  return merged;
}

/** {root} / {cwd} 模板替换（bin / cwd 字段均支持）。 */
function resolveTemplate(template: string, root: string, cwd: string): string {
  return template.split("{root}").join(root).split("{cwd}").join(cwd);
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
  readonly extensions: readonly string[] = [];
  readonly startupTimeoutMs: number | undefined;
  readonly diagnosticsWaitMs: number | undefined;
  readonly config: ServerConfig;

  constructor(id: string, config: ServerConfig) {
    this.id = id;
    this.config = config;
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
    return {
      process: spawnProcess(resolved, this.config.args ?? [], {
        cwd: resolveTemplate(this.config.cwd ?? "{root}", root, cwd),
      }),
      initialization: this.config.initializationOptions,
      settings: this.config.settings,
      languageIds: this.config.languageIdByExtension,
    };
  }
}

/** 组装启用的服务器列表：默认配置 + 用户 servers（id → 配置）合并。 */
export function createAdapters(
  userServers?: Readonly<Record<string, ServerConfig>>,
): LspServerAdapter[] {
  return Object.entries(mergeServerConfigs(defaultServers, userServers)).map(
    ([id, config]) => new ConfigAdapter(id, config),
  );
}
