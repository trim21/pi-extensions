/**
 * Session groups for the talk mailbox: an explicit, uuid-addressed set of
 * sessions that see only each other. Core layer — depends only on
 * TalkStorage, never on pi.
 *
 * Rules:
 * - A session belongs to at most one group (single-group invariant).
 * - Groups are public: any session can join any group by its uuid, and a
 *   member can leave freely. There is no owner.
 * - Visibility is fully group-driven: a grouped session sees only its
 *   co-members; a session in no group sees only itself.
 * - A group that empties is deleted; a one-member group is a normal state
 *   (a creator waiting for peers to join).
 */

import { randomUUID } from "node:crypto";

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import type { TalkStorage } from "./storage.js";

export const GroupSchema = Type.Object({
  id: Type.String(),
  /** pi session uuids of the members. */
  members: Type.Array(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type Group = Static<typeof GroupSchema>;

export const GROUPS_NS = "groups";

/**
 * Group names are user-facing and become storage keys, so they are
 * constrained: start with a letter/digit, then letters, digits, '-' or '_'.
 * A generated uuid fits this pattern too.
 */
const GROUP_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function assertGroupId(id: string): void {
  if (!GROUP_ID_PATTERN.test(id)) throw new TypeError(`Invalid group name: ${id}`);
}

export function isValidGroupName(id: string): boolean {
  return GROUP_ID_PATTERN.test(id);
}

export function newGroupId(): string {
  return randomUUID();
}

function groupKey(id: string): string {
  assertGroupId(id);
  return `${id}.json`;
}

/** All groups, oldest first. Never mutates anything. */
export async function listGroups(storage: TalkStorage): Promise<Group[]> {
  const out: Group[] = [];
  for (const key of await storage.listKeys(GROUPS_NS)) {
    const raw = await storage.readJson(GROUPS_NS, key);
    if (Value.Check(GroupSchema, raw)) out.push(raw);
  }
  return out.toSorted((a, b) => a.createdAt - b.createdAt);
}

export async function readGroup(storage: TalkStorage, id: string): Promise<Group | null> {
  const raw = await storage.readJson(GROUPS_NS, groupKey(id));
  return Value.Check(GroupSchema, raw) ? raw : null;
}

export async function writeGroup(storage: TalkStorage, group: Group): Promise<void> {
  await storage.writeJson(GROUPS_NS, groupKey(group.id), group);
}

export async function deleteGroup(storage: TalkStorage, id: string): Promise<boolean> {
  return storage.removeKey(GROUPS_NS, groupKey(id));
}

/**
 * The group a session currently belongs to. Under the single-group invariant
 * this is at most one; corrupted data that lists the session in several
 * groups resolves to the first match.
 */
export async function groupForSession(
  storage: TalkStorage,
  sessionId: string,
): Promise<Group | null> {
  for (const group of await listGroups(storage)) {
    if (group.members.includes(sessionId)) return group;
  }
  return null;
}
