/**
 * LSP 服务器插件契约：每个语言服务器一个 adapter class，向管理器提供统一接口。
 *
 * - findRoot 返回 undefined 表示该文件不应启用此服务器（目录外 / 无项目标记）；
 * - spawn 返回 undefined 表示服务器不可用（二进制未安装）。
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";

import { exists, walkUp } from "./bin.js";

export interface LspServerHandle {
  process: ChildProcessWithoutNullStreams;
  /** initialize 请求的 initializationOptions。 */
  initialization?: Record<string, unknown>;
  /** didChangeConfiguration / workspace/configuration 的 settings；缺省回退 initialization。 */
  settings?: Record<string, unknown>;
  /** didOpen 的 per-server languageId 映射；缺省回退内置 LANGUAGE_EXTENSIONS 表。 */
  languageIds?: Record<string, string>;
}

export interface LspServerAdapter {
  readonly id: string;
  /** 关联的文件扩展名（含点，小写）；空数组表示匹配所有文件。 */
  readonly extensions: readonly string[];
  /** per-server initialize 握手超时（ms）；缺省用全局配置 / client 默认。 */
  readonly startupTimeoutMs?: number;
  /** per-server 诊断等待时长（ms）；缺省用全局配置 / client 默认。 */
  readonly diagnosticsWaitMs?: number;
  findRoot(file: string, cwd: string): Promise<string | undefined>;
  spawn(root: string, cwd: string): Promise<LspServerHandle | undefined>;
}

/**
 * 从文件所在目录向上（到 cwd）找项目标记文件；找不到时返回 cwd（opencode 的
 * NearestRoot 宽松语义，保证项目内文件至少有一个 root）。
 */
export function nearestRoot(
  markers: readonly string[],
  file: string,
  cwd: string,
): Promise<string> {
  for (const dir of walkUp(dirname(file), cwd)) {
    for (const marker of markers) {
      if (exists(join(dir, marker))) return Promise.resolve(dir);
    }
  }
  return Promise.resolve(cwd);
}
