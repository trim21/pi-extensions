/**
 * codemode 的文件原语（`fs.read` / `fs.write`）：宿主用 `node:fs/promises` 直接读写，
 * 不走工具总线——它们不是工具，不出现在工具列表里，也不参与工具开关与 active 工具求交。
 *
 * 两条保护与文件工具完全一致，而且共用同一份状态：
 * - stale 保护：写入前要求目标文件「已读且读后未变」（`file-reads.ts` 的
 *   `requireCurrentRead`），文件不存在时允许直接创建；读与写都记账，因此工具读过的
 *   文件脚本可以直接写，反之亦然。
 * - 审批：写入经 write-guard（工作区内与 `/tmp` 放行，区外弹 diff 审批，headless /
 *   Windows / 请求策略下直接拒绝）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  type FileSnapshot,
  type ReadsState,
  recordRead,
  requireCurrentRead,
  snapshotOf,
} from "../lib/file-reads.js";
import { parseWithSchema } from "../lib/parse-with-schema.js";
import type { RequestPolicy } from "../lib/request-policy.js";
import { guardWriteAccess } from "../lib/write-guard.js";

const readArgsSchema = Type.Object({ path: Type.String() });
const writeArgsSchema = Type.Object({ path: Type.String(), content: Type.String() });

const FS_READ = "fs.read";
const FS_WRITE = "fs.write";

export interface FsCallContext {
  ctx: ExtensionContext;
  signal?: AbortSignal;
}

/** 一次 fs 原语的结果：`value` 回给脚本，`reads` 是本次新增的已读记账（进 details.reads）。 */
export interface FsCallResult {
  value?: unknown;
  reads?: Record<string, FileSnapshot>;
}

export interface CodemodeFs {
  /** 该名字是否归 fs 原语（`fs.read` / `fs.write`）。 */
  handles(name: string): boolean;
  /** 执行一次 fs 原语；失败抛错，由调用方转成脚本侧的错误。 */
  execute(name: string, args: unknown, call: FsCallContext): Promise<FsCallResult>;
}

export interface CodemodeFsOptions {
  /** 与写类工具共享的请求策略：`/bwrap-deny-request` 生效时工作区外写入直接拒绝。 */
  policy: RequestPolicy;
  /** 与文件工具共享的已读记账。 */
  reads: ReadsState;
}

/**
 * 解码 UTF-8：`ignoreBOM: true` 表示不特殊处理 BOM（即保留它），这样内容与磁盘字节
 * 一一对应——记账指纹与审批预览都是按原始字节比对的，丢掉 BOM 会让两者对不上。
 */
function decodeUtf8(buffer: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new Error(
      `Cannot read "${path}" as UTF-8 text: the file is not valid UTF-8 (binary files are not supported).`,
    );
  }
}

/** 读文件；不存在时返回 undefined（新建文件免已读），其余错误照常抛出。 */
async function readIfExists(path: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  try {
    return await readFile(path, { signal });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function createCodemodeFs(options: CodemodeFsOptions): CodemodeFs {
  const { policy, reads } = options;

  async function read(args: unknown, call: FsCallContext): Promise<FsCallResult> {
    const { path } = parseWithSchema(readArgsSchema, args);
    const absolutePath = resolve(call.ctx.cwd, path);
    // 不设大小上限：内容不进模型上下文，放不下时（VM 堆不够）会以错误回到脚本里
    const buffer = await readFile(absolutePath, { signal: call.signal });
    const text = decodeUtf8(buffer, absolutePath);
    // 指纹按磁盘字节算：与文件工具共用记账，两侧的 digest 必须能互相对上
    const recorded = await recordRead(reads, absolutePath, snapshotOf(buffer));
    return { value: text, reads: recorded };
  }

  async function write(args: unknown, call: FsCallContext): Promise<FsCallResult> {
    const { path, content } = parseWithSchema(writeArgsSchema, args);
    const absolutePath = resolve(call.ctx.cwd, path);
    const existing = await readIfExists(absolutePath, call.signal);
    if (existing !== undefined) {
      await requireCurrentRead(reads, absolutePath, existing);
    }
    await guardWriteAccess(call.ctx, {
      toolName: FS_WRITE,
      absolutePath,
      mutation: {
        contentOld: existing === undefined ? "" : decodeUtf8(existing, absolutePath),
        contentNew: content,
      },
      policy,
      signal: call.signal,
    });
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, { encoding: "utf8", signal: call.signal });
    const recorded = await recordRead(reads, absolutePath, snapshotOf(content));
    return { reads: recorded };
  }

  return {
    handles(name) {
      return name === FS_READ || name === FS_WRITE;
    },
    async execute(name, args, call) {
      if (name === FS_READ) {
        return await read(args, call);
      }
      if (name === FS_WRITE) {
        return await write(args, call);
      }
      throw new Error(`Unknown fs operation "${name}".`);
    },
  };
}
