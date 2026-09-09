/**
 * LSP 服务器插件契约：每个语言服务器一个 adapter class，向管理器提供统一接口。
 *
 * - root 由 serverRoot 按文件的 rootMarkers / workingDir 解析（缺省调用 cwd）；
 *   文件必须位于 root 之内且命中 include（未配置时全匹配）才会由该服务器处理；
 * - spawn 返回 undefined 表示服务器不可用（二进制未安装）。
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { exists } from "./bin.js";

export interface LspServerHandle {
  process: ChildProcessWithoutNullStreams;
  /** initialize 请求的 initializationOptions。 */
  initialization?: Record<string, unknown>;
  /** didChangeConfiguration / workspace/configuration 的 settings；缺省回退 initialization。 */
  settings?: Record<string, unknown>;
  /** didOpen 的 per-server languageId 映射；缺省回退内置 LANGUAGE_EXTENSIONS 表。 */
  languageIds?: Record<string, string>;
}

/** 服务器类型：真语言服务器（language，可承载符号级请求）或 LSP 协议 linter。 */
export type ServerKind = "language" | "linter";

export interface LspServerAdapter {
  readonly id: string;
  /** 服务器类型；缺省视为 "language"（诊断之外的符号级功能只面向 language）。 */
  readonly kind?: ServerKind;
  /** 关联的文件扩展名（含点，小写）；空数组表示匹配所有文件。 */
  readonly extensions: readonly string[];
  /**
   * 文件 glob（相对 root 或调用 cwd）；缺省/空 = 匹配所有文件。
   * 过滤在管理器的 client 匹配阶段完成，adapter 不再持有 findRoot。
   */
  readonly include?: readonly string[];
  /** 服务器工作目录（即 LSP root）：绝对路径或相对调用 cwd 的路径；缺省即 cwd。与 rootMarkers 互斥。 */
  readonly workingDir?: string;
  /**
   * 项目根标记文件名（精确匹配，目录名亦可）：从调用 cwd 沿文件路径向下逐级查找，
   * 第一个含任一标记的目录即 root（cwd 自身命中即 cwd），未命中回退 cwd。
   * 与 workingDir 互斥。
   */
  readonly rootMarkers?: readonly string[];
  /** per-server initialize 握手超时（ms）；缺省用全局配置 / client 默认。 */
  readonly startupTimeoutMs?: number;
  /** per-server 诊断等待时长（ms）；缺省用全局配置 / client 默认。 */
  readonly diagnosticsWaitMs?: number;
  spawn(root: string, cwd: string): Promise<LspServerHandle | undefined>;
}

/**
 * cwd → target 的目录链（含两端）。target 在 cwd 之外时只返回 cwd，
 * 保证 rootMarkers 搜索不越过会话工作目录。
 */
function dirChain(cwd: string, target: string): string[] {
  const dirs = [cwd];
  const rel = relative(cwd, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return dirs;
  let current = cwd;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    dirs.push(current);
  }
  return dirs;
}

/**
 * 解析文件的服务器 root：
 * - 配置了 rootMarkers（非空）时从 cwd 沿文件路径向下找第一个含任一标记的目录
 *   （cwd 自身命中即 cwd），路径上没有命中回退 cwd；
 * - 否则即 workingDir（相对 cwd 解析，绝对路径原样）或 cwd。
 *
 * 取最外层（最靠近 cwd）的命中目录：cwd 是项目根时 root 恒为 cwd，rootMarkers
 * 只在"cwd 是容器目录、其下有多个独立项目"时生效。反向的最近优先会让 root 比
 * 根 tsconfig 更深，而 tsserver 的 tsconfig 搜索被 root 截断，根配置将不再加载。
 */
export function serverRoot(
  adapter: Pick<LspServerAdapter, "workingDir" | "rootMarkers">,
  file: string,
  cwd: string,
): string {
  const markers = adapter.rootMarkers ?? [];
  if (markers.length > 0) {
    for (const dir of dirChain(cwd, dirname(file))) {
      if (markers.some((marker) => exists(join(dir, marker)))) return dir;
    }
    return cwd;
  }
  return adapter.workingDir === undefined ? cwd : resolve(cwd, adapter.workingDir);
}
