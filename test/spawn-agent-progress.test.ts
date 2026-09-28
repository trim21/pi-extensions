/**
 * Tests for the spawn-agent progress state machine. The module is driven
 * directly (no AgentSession): the event → noteX translation lives in
 * spawn-agent.ts and is covered end-to-end by spawn-agent.test.ts, so these
 * cases pin the state machine's own rules — rolling window, tool merging,
 * transient thinking line, footer and line sanitizing.
 */
import { describe, expect, it } from "vitest";

import {
  createSubagentProgress,
  formatTokens,
  type SubagentProgress,
} from "../src/spawn-agent-progress.js";

const ZERO_USAGE = { turns: 0, cost: 0, contextTokens: 0 };

function render(progress: SubagentProgress): string[] {
  return progress.render(ZERO_USAGE).split("\n");
}

describe("createSubagentProgress", () => {
  it("keeps only the last maxLines log lines", () => {
    const progress = createSubagentProgress({ name: "scout", maxLines: 2 });
    progress.noteTextBlock("one");
    progress.noteTextBlock("two");
    progress.noteTextBlock("three");
    expect(render(progress)).toEqual(["text: two", "text: three", "`scout`"]);
  });

  it("merges consecutive calls of the same tool into a count", () => {
    const progress = createSubagentProgress({ name: "scout" });
    progress.noteToolCall("read");
    progress.noteToolCall("read");
    progress.noteToolCall("read");
    expect(render(progress)).toEqual(["tool: read x 3", "`scout`"]);
  });

  it("lists different tools in call order, counting only consecutive repeats", () => {
    const progress = createSubagentProgress({ name: "scout" });
    for (const name of ["a", "a", "b", "a", "c"]) {
      progress.noteToolCall(name);
    }
    expect(render(progress)).toEqual(["tool: a x 2, b, a, c", "`scout`"]);
  });

  it("starts a fresh tool line after a text block", () => {
    const progress = createSubagentProgress({ name: "scout" });
    progress.noteToolCall("read");
    progress.noteTextBlock("Found it.");
    progress.noteToolCall("read");
    expect(render(progress)).toEqual(["tool: read", "text: Found it.", "tool: read", "`scout`"]);
  });

  it("keeps merging tool calls across a thinking block", () => {
    const progress = createSubagentProgress({ name: "scout" });
    progress.noteToolCall("read");
    progress.noteToolCall("read");
    progress.thinkingStart();
    progress.thinkingDelta(3);
    progress.thinkingEnd();
    progress.noteToolCall("grep");
    expect(render(progress)).toEqual(["tool: read x 2, grep", "`scout`"]);
  });

  it("shows the transient thinking line above the footer, outside the window", () => {
    const progress = createSubagentProgress({ name: "scout", maxLines: 2 });
    progress.noteTextBlock("one");
    progress.noteTextBlock("two");
    progress.noteTextBlock("three");
    progress.thinkingStart();
    progress.thinkingDelta(3);
    progress.thinkingDelta(4);
    expect(render(progress)).toEqual([
      "text: two",
      "text: three",
      "thinking ( 7 chars )",
      "`scout`",
    ]);
    progress.thinkingEnd();
    expect(render(progress)).toEqual(["text: two", "text: three", "`scout`"]);
  });

  it("keeps the footer as the last line while the window scrolls", () => {
    const progress = createSubagentProgress({ name: "scout", maxLines: 2 });
    for (let i = 0; i < 5; i++) {
      progress.noteTextBlock(`line${i}`);
    }
    const lines = render(progress);
    expect(lines).toHaveLength(3);
    expect(lines.at(-1)).toBe("`scout`");
  });

  it("strips markdown markers and folds newlines into single spaces", () => {
    const progress = createSubagentProgress({ name: "scout" });
    progress.noteTextBlock("**Bold**\n# H2");
    progress.noteTextBlock("a\tb   c");
    expect(render(progress)).toEqual(["text: Bold H2", "text: a b c", "`scout`"]);
  });

  it("strips markdown markers from tool names", () => {
    const progress = createSubagentProgress({ name: "scout" });
    progress.noteToolCall("We*ird`Tool");
    expect(render(progress)).toEqual(["tool: WeirdTool", "`scout`"]);
  });

  it("folds over-long content to 9 chars, ellipsis and 9 chars (21 total)", () => {
    const progress = createSubagentProgress({ name: "scout" });
    progress.noteTextBlock("a".repeat(120));
    const [line] = render(progress);
    expect(line).toBe(`text: ${"a".repeat(9)} … ${"a".repeat(9)}`);
    expect(line.slice("text: ".length)).toHaveLength(21);
  });

  it("appends usage stats and the model to the footer", () => {
    const progress = createSubagentProgress({ name: "scout" });
    expect(
      progress.render({ turns: 1, cost: 0.0123, contextTokens: 456 }, "claude-haiku-4-5"),
    ).toBe("`scout` 1 turn $0.0123 ctx:456 claude-haiku-4-5");
  });
});

describe("formatTokens", () => {
  it("formats token counts for humans", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(15_000)).toBe("15k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});
