/**
 * read-before-edit 记账：已读文件的内容指纹快照 + 会话分支重放。
 *
 * claude-code 与 opencode 两套工具集共用这一份机制（守卫语义、错误文案、
 * details.reads 格式一致），差异只有两点：
 * - 工具名集合：claude-code 是大写 Read/Edit/Write，opencode 是小写；
 * - 指纹来源：claude-code 手里已有内容，直接 snapshotOf(content)；opencode 的
 *   read 是流式分页读取，整文件指纹用 fileDigest(path)。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath } from "node:fs/promises";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const fileSnapshotSchema = Type.Object({
  digest: Type.String(),
  textEditable: Type.Boolean(),
});

export type FileSnapshot = Static<typeof fileSnapshotSchema>;

/** 已读文件记账：key 为解析 symlink 后的路径 → 读取时的内容指纹。 */
export interface ReadsState {
  readonly reads: Map<string, FileSnapshot>;
}

export function createReadsState(): ReadsState {
  return { reads: new Map() };
}

export function snapshotOf(content: Uint8Array | string, textEditable = true): FileSnapshot {
  return { digest: createHash("sha256").update(content).digest("hex"), textEditable };
}

/** 整文件指纹：流式读取，避免为记账把大文件整个读进内存。 */
export async function fileDigest(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** ENOENT / ENOTDIR：路径不存在。 */
function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** 磁盘上当前内容的指纹；文件已不存在时返回 undefined（视为「与读取时不同」）。 */
export async function digestIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fileDigest(filePath);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
}

/**
 * 记账 key：解析 symlink 后的真实路径。文件尚不存在（Write 新建 / Edit 空
 * old_string 创建）时 realpath 抛 ENOENT，回退到调用方给出的路径。
 */
export async function readStateKey(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (isMissingPath(error)) return filePath;
    throw error;
  }
}

export function snapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.digest === right.digest;
}

/** 校验「已读且未变」：未读过、非文本、指纹不符都拒绝写入。 */
export function requireCurrentRead(
  state: ReadsState,
  key: string,
  filePath: string,
  currentContent: Uint8Array | string,
): void {
  const readSnapshot = state.reads.get(key);
  if (!readSnapshot) {
    throw new Error("File has not been read yet. Read it first before writing to it.");
  }
  if (!readSnapshot.textEditable) {
    throw new Error(`Cannot edit or overwrite a binary file with a text tool: ${filePath}`);
  }
  if (!snapshotsEqual(readSnapshot, snapshotOf(currentContent))) {
    throw new Error(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
  }
}

/**
 * 过期校验：该文件已有读取记录时，要求磁盘上的当前指纹与记录一致，否则拒绝
 * 写入；从未读过（没有记录）时直接放行。
 *
 * opencode 的 write 用这个：没读过的文件允许直接写，读过之后再被外部改动就必须
 * 重新 read。`currentDigest` 为 undefined（文件已不存在）同样算过期。
 */
export function requireUnchangedRead(
  state: ReadsState,
  key: string,
  currentDigest: string | undefined,
): void {
  const readSnapshot = state.reads.get(key);
  if (!readSnapshot) return;
  if (currentDigest === undefined || readSnapshot.digest !== currentDigest) {
    throw new Error(
      "File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
    );
  }
}

/**
 * 从工具结果 details 恢复已读记账（跨进程 resume / reload / fork）。数据来自
 * session 文件，可能缺失或损坏：逐条 TypeBox 校验，非法条目丢弃。只接受
 * plain object，数组、null 等异常形态直接返回空 map。
 */
export function deserializeReads(data: unknown): Map<string, FileSnapshot> {
  const reads = new Map<string, FileSnapshot>();
  if (typeof data !== "object" || data === null || Array.isArray(data)) return reads;
  for (const [filePath, snapshot] of Object.entries(data)) {
    if (Value.Check(fileSnapshotSchema, snapshot)) reads.set(filePath, snapshot);
  }
  return reads;
}

/**
 * 先清空再重放当前分支，保证 state 只反映当前分支：rewind / fork / resume 后，
 * 被抛弃分支上的已读不再残留。工具名集合由调用方给出（两套工具集大小写不同）。
 */
export function restoreReads(
  state: ReadsState,
  sessionManager: ExtensionContext["sessionManager"],
  toolNames: ReadonlySet<string>,
): void {
  state.reads.clear();
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    if (!toolNames.has(entry.message.toolName)) continue;
    const details = entry.message.details as { reads?: unknown } | undefined;
    if (!details?.reads) continue;
    for (const [filePath, snapshot] of deserializeReads(details.reads)) {
      state.reads.set(filePath, snapshot);
    }
  }
}
