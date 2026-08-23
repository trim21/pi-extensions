/**
 * Tests for the opencode edit matching engine:
 * - BOM / line-ending helpers
 * - replace(): each of the 9 replacers and the error paths
 *
 * The replacers run in order and the first match wins, so each test is
 * constructed so the earlier replacers cannot match and the intended one
 * produces the unique match.
 */
import { describe, expect, it } from "vitest";

import {
  applyEdit,
  convertToLineEnding,
  detectLineEnding,
  normalizeForEdit,
  normalizeToLF,
  replace,
  restoreLineEndings,
  stripBom,
} from "../src/opencode/edit-engine.js";

describe("BOM helpers", () => {
  it("extracts a leading BOM", () => {
    expect(stripBom("\uFEFFabc")).toEqual({ bom: "\uFEFF", text: "abc" });
  });

  it("returns no BOM when absent", () => {
    expect(stripBom("abc")).toEqual({ bom: "", text: "abc" });
  });
});

describe("line ending helpers", () => {
  it("detects CRLF vs LF", () => {
    expect(detectLineEnding("a\r\nb")).toBe("\r\n");
    expect(detectLineEnding("a\nb")).toBe("\n");
    expect(detectLineEnding("a\nb\r\nc")).toBe("\r\n");
  });

  it("normalizes CRLF to LF", () => {
    expect(normalizeToLF("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("restores CRLF when requested, keeps LF otherwise", () => {
    expect(restoreLineEndings("a\nb", "\r\n")).toBe("a\r\nb");
    expect(restoreLineEndings("a\nb", "\n")).toBe("a\nb");
  });

  it("normalizeForEdit strips BOM and normalizes CRLF", () => {
    expect(normalizeForEdit("\uFEFFa\r\nb\r\n")).toBe("a\nb\n");
  });
});

describe("replace()", () => {
  it("replaces an exact match (SimpleReplacer)", () => {
    expect(replace("hello world", "world", "there")).toBe("hello there");
  });

  it("replaces a unique middle match", () => {
    expect(replace("a\nb\na", "b", "B")).toBe("a\nB\na");
  });

  it("replaceAll replaces every occurrence", () => {
    expect(replace("abcabc", "abc", "x", true)).toBe("xx");
  });

  it("throws when oldString and newString are identical", () => {
    expect(() => replace("abc", "a", "a")).toThrow(/identical/);
  });

  it("throws on an empty oldString", () => {
    expect(() => replace("abc", "", "x")).toThrow(/oldString cannot be empty/);
  });

  it("throws when oldString is not found", () => {
    expect(() => replace("abc", "def", "x")).toThrow(/Could not find oldString/);
  });

  it("throws when oldString matches multiple times", () => {
    expect(() => replace("abcabc", "abc", "x")).toThrow(/multiple matches/);
  });

  it("matches lines ignoring leading/trailing whitespace (LineTrimmedReplacer)", () => {
    // the matched span keeps the surrounding whitespace of the original lines
    expect(replace("  foo\nbar  ", "foo\nbar", "X")).toBe("  X  ");
  });

  it("matches a block whose inner lines are similar (BlockAnchorReplacer)", () => {
    const content = "start\nsame\nsame!\nend";
    const find = "start\nsame\nsame\nend";
    expect(replace(content, find, "X")).toBe("X");
  });

  it("matches whitespace-collapsed single lines (WhitespaceNormalizedReplacer)", () => {
    expect(replace("const   x = 1", "const x", "Y")).toBe("Y = 1");
  });

  it("matches escaped sequences against raw content (EscapeNormalizedReplacer)", () => {
    expect(replace("foo\nbar", String.raw`foo\nbar`, "Z")).toBe("Z");
  });

  it("matches a trimmed boundary inside content (TrimmedBoundaryReplacer)", () => {
    // oldString has surrounding spaces; only the inner "a\nb" exists in content
    expect(replace("x\naa\nb\ny", " a\nb ", "Z")).toBe("x\naZ\ny");
  });

  it("matches a block with ≥50% identical inner lines (ContextAwareReplacer)", () => {
    const content = "x\nstart\nk1\nk2\nX\nX\nend\ny";
    const find = "start\nk1\nk2\nk3\nk4\nend";
    expect(replace(content, find, "Z")).toBe("x\nZ\ny");
  });

  it("replaceAll interpolates $& the way String.prototype.replaceAll does", () => {
    expect(replace("ab", "a", "$&x", true)).toBe("axb");
  });
});

describe("applyEdit()", () => {
  it("converts LF params to match a CRLF file without doubling CR", () => {
    const applied = applyEdit("one\r\ntwo\r\nthree\r\n", "two", "TWO");
    expect(applied.contentNew).toBe("one\r\nTWO\r\nthree\r\n");
    expect(applied.finalContent).toBe("one\r\nTWO\r\nthree\r\n");
  });

  it("converts CRLF params to match an LF file", () => {
    const applied = applyEdit("one\ntwo\nthree\n", "one\r\ntwo", "ONE\r\nTWO");
    expect(applied.contentNew).toBe("ONE\nTWO\nthree\n");
  });

  it("does not turn newString CRLF into CRCRLF on a CRLF file", () => {
    const applied = applyEdit("one\r\ntwo\r\n", "two", "TWO\r\nextra");
    expect(applied.contentNew).toBe("one\r\nTWO\r\nextra\r\n");
    expect(applied.contentNew).not.toContain("\r\r\n");
  });

  it("preserves an existing BOM and does not keep a BOM from the middle of newString", () => {
    const applied = applyEdit("\uFEFFone\ntwo\n", "two", "TWO");
    expect(applied.finalContent).toBe("\uFEFFone\nTWO\n");
  });

  it("promotes a leading BOM from the replacement when the file had none", () => {
    const applied = applyEdit("one\ntwo\n", "one", "\uFEFFONE");
    expect(applied.finalContent).toBe("\uFEFFONE\ntwo\n");
  });

  it("convertToLineEnding is an alias of restoreLineEndings", () => {
    expect(convertToLineEnding("a\nb", "\r\n")).toBe("a\r\nb");
    expect(restoreLineEndings("a\nb", "\r\n")).toBe("a\r\nb");
  });
});
