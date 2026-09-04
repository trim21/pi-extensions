/**
 * LSP 服务器插件契约：每个语言服务器一个 adapter class，向管理器提供统一接口。
 *
 * - root 由管理器按 workingDir 计算（缺省调用 cwd）；文件必须位于 root 之内
 *   且命中 include（未配置时全匹配）才会由该服务器处理；
 * - spawn 返回 undefined 表示服务器不可用（二进制未安装）。
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";

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
  /** 服务器工作目录（即 LSP root）：绝对路径或相对调用 cwd 的路径；缺省即 cwd。 */
  readonly workingDir?: string;
  /** per-server initialize 握手超时（ms）；缺省用全局配置 / client 默认。 */
  readonly startupTimeoutMs?: number;
  /** per-server 诊断等待时长（ms）；缺省用全局配置 / client 默认。 */
  readonly diagnosticsWaitMs?: number;
  spawn(root: string, cwd: string): Promise<LspServerHandle | undefined>;
}

/** 计算服务器 root：workingDir 未配置时即调用 cwd，否则相对 cwd 解析（绝对路径原样）。 */
export function serverRoot(workingDir: string | undefined, cwd: string): string {
  return workingDir === undefined ? cwd : resolve(cwd, workingDir);
}
