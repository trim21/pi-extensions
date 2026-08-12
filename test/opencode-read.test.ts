/**
 * Tests for the opencode-aligned read extension:
 * - truncateHead: line cap, byte cap, single-line 2000-char truncation,
 *   trailing-newline handling, no-truncation fast path
 */
import { describe, expect, it } from "vitest";

import { truncateHead } from "../src/opencode-read.js";

const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;

describe("truncateHead", () => {
  it("returns content unchanged when within limits", () => {
    const result = truncateHead("a\nb\nc", 2000, 50 * 1024);
    expect(result).toMatchObject({
      content: "a\nb\nc",
      truncated: false,
      truncatedBy: null,
      totalLines: 3,
      outputLines: 3,
    });
  });

  it("does not truncate when line count exactly equals maxLines", () => {
    const result = truncateHead("a\nb", 2, 50 * 1024);
    expect(result.truncated).toBe(false);
    expect(result.outputLines).toBe(2);
  });

  it("truncates by lines when exceeding maxLines", () => {
    const result = truncateHead("1\n2\n3\n4\n5", 2, 50 * 1024);
    expect(result).toMatchObject({
      content: "1\n2",
      truncated: true,
      truncatedBy: "lines",
      totalLines: 5,
      outputLines: 2,
    });
  });

  it("truncates by bytes before the offending line", () => {
    // 每行 6 字节 + 换行 1 字节；maxBytes=10 → 第二行累计 13 > 10
    const result = truncateHead("aaaaaa\nbbbbbb", 2000, 10);
    expect(result).toMatchObject({
      content: "aaaaaa",
      truncated: true,
      truncatedBy: "bytes",
      outputLines: 1,
    });
  });

  it("truncates a single over-long line to MAX_LINE_LENGTH with a suffix", () => {
    const longLine = "x".repeat(MAX_LINE_LENGTH + 10);
    const result = truncateHead(longLine, 2000, 50 * 1024);
    expect(result.content).toBe("x".repeat(MAX_LINE_LENGTH) + MAX_LINE_SUFFIX);
    expect(result.truncated).toBe(false); // 单行截断不算整体截断
    expect(result.outputLines).toBe(1);
  });

  it("counts lines without the trailing empty line from a final newline", () => {
    const result = truncateHead("a\nb\n", 2000, 50 * 1024);
    expect(result).toMatchObject({ totalLines: 2, outputLines: 2, truncated: false });
  });

  it("handles empty content", () => {
    const result = truncateHead("", 2000, 50 * 1024);
    expect(result).toMatchObject({ content: "", truncated: false, outputLines: 0 });
  });
});
