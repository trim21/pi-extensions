/**
 * Tests for the workspace-guard diff preview (buildDiffPreview).
 *
 * Diff previews are asserted with inline snapshots so the exact rendered diff
 * is visible in this file for review.
 *
 * Paths are fixed (not mkdtemp) so the `--- a/...` patch headers stay stable
 * across runs and the snapshots remain reproducible.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { buildDiffPreview, getWriteTarget } from "../src/workspace-guard.js";

const SNAPSHOT_DIR = join(tmpdir(), "workspace-guard-inline-snapshot");
const TARGET = join(SNAPSHOT_DIR, "target.txt");
const MISSING = join(SNAPSHOT_DIR, "missing.txt");

beforeEach(async () => {
  await rm(SNAPSHOT_DIR, { recursive: true, force: true });
  await mkdir(SNAPSHOT_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(SNAPSHOT_DIR, { recursive: true, force: true });
});

describe("getWriteTarget", () => {
  it("extracts the target from built-in and opencode inputs", () => {
    // built-in write: { path, content }
    expect(getWriteTarget({ path: "/x", content: "" })).toBe("/x");
    // opencode write: { filePath, content }
    expect(getWriteTarget({ filePath: "/y", content: "" })).toBe("/y");
    // built-in edit: { path, edits }
    expect(getWriteTarget({ path: "/z", edits: [] })).toBe("/z");
    // opencode edit: { filePath, oldString, newString }
    expect(getWriteTarget({ filePath: "/w", oldString: "a", newString: "b" })).toBe("/w");
  });
});

describe("buildDiffPreview", () => {
  it("write to a new file shows a full-addition patch", async () => {
    const preview = await buildDiffPreview(
      "write",
      { path: TARGET, content: "one\ntwo\n" },
      TARGET,
    );

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

  it("opencode write format (filePath/content) is supported", async () => {
    const preview = await buildDiffPreview(
      "write",
      { filePath: TARGET, content: "hello\n" },
      TARGET,
    );

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      --- target.txt
      +++ target.txt
      @@ -0,0 +1,1 @@
      +hello

      \`\`\`"
    `);
  });

  it("built-in edit format (edits[]) produces a patch", async () => {
    await writeFile(TARGET, "one\ntwo\nthree\n", "utf8");

    const preview = await buildDiffPreview(
      "edit",
      { path: TARGET, edits: [{ oldText: "two", newText: "TWO" }] },
      TARGET,
    );

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

  it("built-in edit applies multiple edits in order", async () => {
    await writeFile(TARGET, "one\ntwo\nthree\n", "utf8");

    const preview = await buildDiffPreview(
      "edit",
      {
        path: TARGET,
        edits: [
          { oldText: "one", newText: "1" },
          { oldText: "three", newText: "3" },
        ],
      },
      TARGET,
    );

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      --- target.txt
      +++ target.txt
      @@ -1,3 +1,3 @@
      -one
      +1
       two
      -three
      +3

      \`\`\`"
    `);
  });

  it("opencode edit with a verbatim oldString shows a line-numbered patch", async () => {
    await writeFile(TARGET, "line one\nline two\nline three\n", "utf8");

    const preview = await buildDiffPreview(
      "edit",
      { filePath: TARGET, oldString: "line two", newString: "line TWO" },
      TARGET,
    );

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      --- target.txt
      +++ target.txt
      @@ -1,3 +1,3 @@
       line one
      -line two
      +line TWO
       line three

      \`\`\`"
    `);
  });

  it("opencode edit replaceAll shows every occurrence changed", async () => {
    await writeFile(TARGET, "alpha\nbeta\nalpha\n", "utf8");

    const preview = await buildDiffPreview(
      "edit",
      { filePath: TARGET, oldString: "alpha", newString: "gamma", replaceAll: true },
      TARGET,
    );

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

  it("opencode edit preview falls back to a parameter diff when oldString is not matched", async () => {
    await writeFile(TARGET, "one\ntwo\n", "utf8");

    const preview = await buildDiffPreview(
      "edit",
      { filePath: TARGET, oldString: "missing", newString: "x" },
      TARGET,
    );

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      -missing
      +x
      \`\`\`"
    `);
  });

  it("opencode edit preview does not require the file to exist", async () => {
    const preview = await buildDiffPreview(
      "edit",
      { filePath: MISSING, oldString: "a\nb", newString: "c" },
      MISSING,
    );

    expect(preview).toMatchInlineSnapshot(`
      "\`\`\`diff
      -a
      -b
      +c
      \`\`\`"
    `);
  });

  it("multiline opencode edit parameters become a multiline diff", async () => {
    await writeFile(TARGET, "unused\n", "utf8");

    const preview = await buildDiffPreview(
      "edit",
      { filePath: TARGET, oldString: "one\ntwo", newString: "1\n2\n3" },
      TARGET,
    );

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

    const preview = await buildDiffPreview("write", { path: TARGET, content }, TARGET);

    expect(preview).toContain("preview truncated to 100 lines");
    const lines = preview!.split("\n");
    expect(lines.length).toBe(103); // 100 diff lines + truncation note + ``` fences
  });
});
