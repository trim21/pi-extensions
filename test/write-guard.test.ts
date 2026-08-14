/**
 * Tests for the embedded workspace write guard (lib/write-guard.ts).
 *
 * - buildDiffPreview: whole-file writes, matched edits, fallback parameter
 *   diffs, and truncation. Asserted with inline snapshots so the exact rendered
 *   diff is visible in this file for review.
 * - guardWriteAccess: path gating (workspace /tmp auto-allow, approval dialog,
 *   headless rejection).
 *
 * Paths are fixed (not mkdtemp) so the `--- a/...` patch headers stay stable
 * across runs and the snapshots remain reproducible.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDiffPreview, guardWriteAccess } from "../src/lib/write-guard.js";

const SNAPSHOT_DIR = join(tmpdir(), "write-guard-inline-snapshot");
const TARGET = join(SNAPSHOT_DIR, "target.txt");
const MISSING = join(SNAPSHOT_DIR, "missing.txt");

/** Workspace used by the guard tests (separate from SNAPSHOT_DIR). */
let WS_DIR: string;
let INSIDE: string;
let OUTSIDE: string;
let TMP_FILE: string;

beforeEach(async () => {
  await rm(SNAPSHOT_DIR, { recursive: true, force: true });
  await mkdir(SNAPSHOT_DIR, { recursive: true });

  WS_DIR = await mkdtemp(join(tmpdir(), "write-guard-ws-"));
  INSIDE = join(WS_DIR, "inside.txt");
  OUTSIDE = "/etc/write-guard-outside.txt";
  TMP_FILE = join(tmpdir(), "write-guard-tmp-file.txt");
  await writeFile(INSIDE, "in\n", "utf8");
});

afterAll(async () => {
  await rm(SNAPSHOT_DIR, { recursive: true, force: true });
  await rm(WS_DIR, { recursive: true, force: true });
  await rm(OUTSIDE, { force: true });
  await rm(TMP_FILE, { force: true });
});

describe("buildDiffPreview", () => {
  it("write to a new file shows a full-addition patch", async () => {
    const preview = await buildDiffPreview(TARGET, { oldText: "", newText: "one\ntwo\n" });

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      --- target.txt
      +++ target.txt
      @@ -0,0 +1,2 @@
      +one
      +two

      \`\`\`"
    `);
  });

  it("write over an existing file shows a replacement patch", async () => {
    await writeFile(TARGET, "old\n", "utf8");

    const preview = await buildDiffPreview(TARGET, { oldText: "", newText: "new\n" });

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      --- target.txt
      +++ target.txt
      @@ -1,1 +1,1 @@
      -old
      +new

      \`\`\`"
    `);
  });

  it("matched edit produces a line-numbered patch", async () => {
    await writeFile(TARGET, "one\ntwo\nthree\n", "utf8");

    const preview = await buildDiffPreview(TARGET, { oldText: "two", newText: "TWO" });

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      --- target.txt
      +++ target.txt
      @@ -1,3 +1,3 @@
       one
      -two
      +TWO
       three

      \`\`\`"
    `);
  });

  it("replaceAll shows every occurrence changed", async () => {
    await writeFile(TARGET, "alpha\nbeta\nalpha\n", "utf8");

    const preview = await buildDiffPreview(TARGET, {
      oldText: "alpha",
      newText: "gamma",
      replaceAll: true,
    });

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      --- target.txt
      +++ target.txt
      @@ -1,3 +1,3 @@
      -alpha
      +gamma
       beta
      -alpha
      +gamma

      \`\`\`"
    `);
  });

  it("falls back to a parameter diff when oldText is not matched", async () => {
    await writeFile(TARGET, "one\ntwo\n", "utf8");

    const preview = await buildDiffPreview(TARGET, { oldText: "missing", newText: "x" });

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      -missing
      +x
      \`\`\`"
    `);
  });

  it("edit preview does not require the file to exist", async () => {
    const preview = await buildDiffPreview(MISSING, { oldText: "a\nb", newText: "c" });

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      -a
      -b
      +c
      \`\`\`"
    `);
  });

  it("multiline edit parameters become a multiline diff", async () => {
    await writeFile(TARGET, "unused\n", "utf8");

    const preview = await buildDiffPreview(TARGET, { oldText: "one\ntwo", newText: "1\n2\n3" });

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      -one
      -two
      +1
      +2
      +3
      \`\`\`"
    `);
  });

  it("truncates very large diffs", async () => {
    const content = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n") + "\n";

    const preview = await buildDiffPreview(TARGET, { oldText: "", newText: content });

    expect(preview).toContain("preview truncated to 100 lines");
    const lines = preview!.split("\n");
    expect(lines.length).toBe(103); // 100 diff lines + truncation note + ``` fences
  });
});

// ── guardWriteAccess ─────────────────────────────────────────────────────────

interface GuardCtx {
  cwd: string;
  hasUI: boolean;
  ui?: {
    select: (title: string, options: string[]) => Promise<string | undefined>;
    input: (title: string, placeholder?: string) => Promise<string | undefined>;
  };
  abort?: () => void;
}

function ctxWith(over: Partial<GuardCtx>): GuardCtx {
  return { cwd: WS_DIR, hasUI: true, ...over };
}

function writeOptions(absolutePath: string) {
  return { toolName: "write", absolutePath, change: { oldText: "", newText: "x" } };
}

describe("guardWriteAccess", () => {
  it("auto-allows writes inside the workspace", async () => {
    await expect(guardWriteAccess(ctxWith({}), writeOptions(INSIDE))).resolves.toBeUndefined();
  });

  it("auto-allows writes to the workspace directory itself", async () => {
    await expect(guardWriteAccess(ctxWith({}), writeOptions(WS_DIR))).resolves.toBeUndefined();
  });

  it("auto-allows writes under /tmp", async () => {
    await expect(guardWriteAccess(ctxWith({}), writeOptions(TMP_FILE))).resolves.toBeUndefined();
  });

  it("rejects outside writes without UI", async () => {
    await expect(
      guardWriteAccess(ctxWith({ hasUI: false }), writeOptions(OUTSIDE)),
    ).rejects.toThrow(/outside workspace/);
  });

  it("approves outside writes when the user picks Approve once", async () => {
    const select = vi.fn(async () => "Approve once");
    await expect(
      guardWriteAccess(ctxWith({ ui: { select, input: vi.fn() } }), writeOptions(OUTSIDE)),
    ).resolves.toBeUndefined();
    expect(select).toHaveBeenCalledWith(
      expect.stringContaining("Model requests write access outside workspace"),
      expect.arrayContaining(["Approve once", "Block", "Block with reason"]),
    );
  });

  it("blocks outside writes when the user picks Block", async () => {
    const select = vi.fn(async () => "Block");
    await expect(
      guardWriteAccess(ctxWith({ ui: { select, input: vi.fn() } }), writeOptions(OUTSIDE)),
    ).rejects.toThrow("Write outside workspace denied by user.");
  });

  it("blocks with a user-supplied reason", async () => {
    const select = vi.fn(async () => "Block with reason");
    const input = vi.fn(async () => "not allowed");
    await expect(
      guardWriteAccess(ctxWith({ ui: { select, input } }), writeOptions(OUTSIDE)),
    ).rejects.toThrow("Write outside workspace denied: not allowed");
  });

  it("retries the dialog when the reason input is cancelled", async () => {
    const select = vi
      .fn(async () => "Block with reason")
      .mockResolvedValueOnce("Block with reason")
      .mockResolvedValueOnce("Block");
    const input = vi.fn(async () => undefined as string | undefined);
    await expect(
      guardWriteAccess(ctxWith({ ui: { select, input } }), writeOptions(OUTSIDE)),
    ).rejects.toThrow("Write outside workspace denied by user.");
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("aborts and blocks when the user cancels the dialog", async () => {
    const abort = vi.fn();
    const select = vi.fn(async () => undefined as string | undefined);
    await expect(
      guardWriteAccess(ctxWith({ ui: { select, input: vi.fn() }, abort }), writeOptions(OUTSIDE)),
    ).rejects.toThrow("Write outside workspace cancelled by user.");
    expect(abort).toHaveBeenCalled();
  });

  it("shows a diff preview for an outside edit", async () => {
    const select = vi.fn(async (title: string) => {
      expect(title).toContain("```diff");
      return "Approve once";
    });
    await expect(
      guardWriteAccess(ctxWith({ ui: { select, input: vi.fn() } }), {
        toolName: "edit",
        absolutePath: OUTSIDE,
        change: { oldText: "two", newText: "TWO" },
      }),
    ).resolves.toBeUndefined();
  });
});
