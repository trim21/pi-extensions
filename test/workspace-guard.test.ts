/**
 * Tests for the workspace-guard diff preview (buildDiffPreview).
 *
 * Diff previews are asserted with inline snapshots so the exact rendered diff
 * is visible in this file for review.
 *
 * Paths are fixed (not mkdtemp) so the `--- a/...` patch headers stay stable
 * across runs and the snapshots remain reproducible.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import workspaceGuard, {
  buildDiffPreview,
  decideOutsideWorkspaceWrite,
  getWriteTarget,
} from "../src/workspace-guard.js";

const SNAPSHOT_DIR = join(tmpdir(), "workspace-guard-inline-snapshot");
const TARGET = join(SNAPSHOT_DIR, "target.txt");
const MISSING = join(SNAPSHOT_DIR, "missing.txt");

/** Workspace used by the tool_call handler tests (separate from SNAPSHOT_DIR). */
let WS_DIR: string;
let INSIDE: string;
let OUTSIDE: string;
let TMP_FILE: string;

beforeEach(async () => {
  await rm(SNAPSHOT_DIR, { recursive: true, force: true });
  await mkdir(SNAPSHOT_DIR, { recursive: true });

  WS_DIR = await mkdtemp(join(tmpdir(), "workspace-guard-ws-"));
  INSIDE = join(WS_DIR, "inside.txt");
  OUTSIDE = "/etc/workspace-guard-outside.txt";
  TMP_FILE = join(tmpdir(), "workspace-guard-tmp-file.txt");
  await writeFile(INSIDE, "in\n", "utf8");
});

afterAll(async () => {
  await rm(SNAPSHOT_DIR, { recursive: true, force: true });
  await rm(WS_DIR, { recursive: true, force: true });
  await rm(OUTSIDE, { force: true });
  await rm(TMP_FILE, { force: true });
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

describe("decideOutsideWorkspaceWrite", () => {
  it("rejects writes in headless sessions without UI", () => {
    const decision = decideOutsideWorkspaceWrite("/etc/passwd", {
      hasUI: false,
    });

    expect(decision.block).toBe(true);
  });

  it("allows the approval flow when interactive UI is available", () => {
    const decision = decideOutsideWorkspaceWrite("/etc/passwd", {
      hasUI: true,
    });

    expect(decision.block).toBe(false);
  });
});

// ── tool_call / before_agent_start handlers ──────────────────────────────────

interface ToolCallLike {
  toolName: string;
  input: Record<string, unknown>;
}

interface GuardCtx {
  cwd: string;
  hasUI: boolean;
  ui?: {
    select: (title: string, options: string[]) => Promise<string | undefined>;
    input: (title: string, placeholder?: string) => Promise<string | undefined>;
  };
  abort?: () => void;
}

type ToolCallHandler = (event: ToolCallLike, ctx: GuardCtx) => Promise<unknown>;
type AgentStartHandler = (
  event: { systemPrompt: string },
  ctx: { cwd: string; hasUI: boolean },
) => { systemPrompt: string } | undefined;

function loadHandlers(): {
  tool_call: ToolCallHandler;
  before_agent_start: AgentStartHandler;
} {
  const handlers: Record<string, unknown> = {};
  workspaceGuard({
    on: (event: string, h: unknown) => {
      handlers[event] = h;
    },
  } as never);
  return {
    tool_call: handlers.tool_call as ToolCallHandler,
    before_agent_start: handlers.before_agent_start as AgentStartHandler,
  };
}

function ctxWith(over: Partial<GuardCtx>): GuardCtx {
  return { cwd: WS_DIR, hasUI: true, ...over };
}

describe("workspace guard handlers", () => {
  it("ignores non-write tools", async () => {
    const { tool_call } = loadHandlers();
    const result = await tool_call({ toolName: "read", input: { path: OUTSIDE } }, ctxWith({}));
    expect(result).toBeUndefined();
  });

  it("ignores writes without a resolvable target", async () => {
    const { tool_call } = loadHandlers();
    const result = await tool_call({ toolName: "write", input: {} }, ctxWith({}));
    expect(result).toBeUndefined();
  });

  it("auto-allows writes inside the workspace", async () => {
    const { tool_call } = loadHandlers();
    const result = await tool_call(
      { toolName: "write", input: { path: INSIDE, content: "x" } },
      ctxWith({}),
    );
    expect(result).toBeUndefined();
  });

  it("auto-allows writes to the workspace directory itself", async () => {
    const { tool_call } = loadHandlers();
    const result = await tool_call(
      { toolName: "write", input: { path: WS_DIR, content: "x" } },
      ctxWith({}),
    );
    expect(result).toBeUndefined();
  });

  it("auto-allows writes under /tmp", async () => {
    const { tool_call } = loadHandlers();
    const result = await tool_call(
      { toolName: "write", input: { path: TMP_FILE, content: "x" } },
      ctxWith({}),
    );
    expect(result).toBeUndefined();
  });

  it("rejects outside writes without UI", async () => {
    const { tool_call } = loadHandlers();
    const result = await tool_call(
      { toolName: "write", input: { path: OUTSIDE, content: "x" } },
      ctxWith({ hasUI: false }),
    );
    expect(result).toMatchObject({ block: true });
    expect((result as { reason: string }).reason).toContain("outside workspace");
  });

  it("approves outside writes when the user picks Approve once", async () => {
    const { tool_call } = loadHandlers();
    const select = vi.fn(async () => "Approve once");
    const result = await tool_call(
      { toolName: "write", input: { path: OUTSIDE, content: "x" } },
      ctxWith({ ui: { select, input: vi.fn() } }),
    );
    expect(result).toBeUndefined();
    expect(select).toHaveBeenCalledWith(
      expect.stringContaining("Model requests write access outside workspace"),
      expect.arrayContaining(["Approve once", "Block", "Block with reason"]),
    );
  });

  it("blocks outside writes when the user picks Block", async () => {
    const { tool_call } = loadHandlers();
    const result = await tool_call(
      { toolName: "write", input: { path: OUTSIDE, content: "x" } },
      ctxWith({ ui: { select: vi.fn(async () => "Block"), input: vi.fn() } }),
    );
    expect(result).toEqual({ block: true, reason: "Write outside workspace denied by user." });
  });

  it("blocks with a user-supplied reason", async () => {
    const { tool_call } = loadHandlers();
    const result = await tool_call(
      { toolName: "write", input: { path: OUTSIDE, content: "x" } },
      ctxWith({
        ui: {
          select: vi.fn(async () => "Block with reason"),
          input: vi.fn(async () => "not allowed"),
        },
      }),
    );
    expect(result).toEqual({
      block: true,
      reason: "Write outside workspace denied: not allowed",
    });
  });

  it("retries the dialog when the reason input is cancelled", async () => {
    const { tool_call } = loadHandlers();
    const select = vi
      .fn(async () => "Block with reason")
      .mockResolvedValueOnce("Block with reason")
      .mockResolvedValueOnce("Block");
    const result = await tool_call(
      { toolName: "write", input: { path: OUTSIDE, content: "x" } },
      ctxWith({ ui: { select, input: vi.fn(async () => undefined as string | undefined) } }),
    );
    expect(select).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ block: true, reason: "Write outside workspace denied by user." });
  });

  it("aborts and blocks when the user cancels the dialog", async () => {
    const { tool_call } = loadHandlers();
    const abort = vi.fn();
    const result = await tool_call(
      { toolName: "write", input: { path: OUTSIDE, content: "x" } },
      ctxWith({
        ui: { select: vi.fn(async () => undefined as string | undefined), input: vi.fn() },
        abort,
      }),
    );
    expect(abort).toHaveBeenCalled();
    expect(result).toEqual({ block: true, reason: "Write outside workspace cancelled by user." });
  });

  it("approves an outside opencode-format edit after showing a diff preview", async () => {
    const { tool_call } = loadHandlers();
    const select = vi.fn(async (title: string) => {
      expect(title).toContain("```diff");
      return "Approve once";
    });
    const result = await tool_call(
      {
        toolName: "edit",
        input: { filePath: OUTSIDE, oldString: "two", newString: "TWO" },
      },
      ctxWith({ ui: { select, input: vi.fn() } }),
    );
    expect(result).toBeUndefined();
  });

  it("approves an edit whose change cannot be applied (no diff preview)", async () => {
    const { tool_call } = loadHandlers();
    const select = vi.fn(async () => "Approve once");
    const result = await tool_call(
      { toolName: "edit", input: { path: OUTSIDE, content: "x" } },
      ctxWith({ ui: { select, input: vi.fn() } }),
    );
    expect(result).toBeUndefined();
  });

  it("injects the workspace protection note into the system prompt (headless)", () => {
    const { before_agent_start } = loadHandlers();
    const result = before_agent_start?.({ systemPrompt: "base" }, { cwd: WS_DIR, hasUI: false });
    expect(result?.systemPrompt).toContain("base");
    expect(result?.systemPrompt).toContain("Workspace write protection is active");
    expect(result?.systemPrompt).toContain("rejected because no UI is available for approval");
  });

  it("injects the approval note when UI is available", () => {
    const { before_agent_start } = loadHandlers();
    const result = before_agent_start?.({ systemPrompt: "base" }, { cwd: WS_DIR, hasUI: true });
    expect(result?.systemPrompt).toContain("require user approval before execution");
  });
});
