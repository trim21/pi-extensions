/**
 * Tests for the command-line argument tokenizer used by /command handlers.
 */
import { describe, expect, it } from "vitest";

import { shlexSplit } from "../src/lib/cli-args.js";

describe("shlexSplit", () => {
  it("splits on whitespace and drops empty tokens", () => {
    expect(shlexSplit("abc  def\tghi")).toEqual(["abc", "def", "ghi"]);
    expect(shlexSplit(" ".repeat(3))).toEqual([]);
    expect(shlexSplit("")).toEqual([]);
  });

  it("preserves quoted tokens as single arguments", () => {
    expect(shlexSplit(`--name "front end"`)).toEqual(["--name", "front end"]);
    expect(shlexSplit(`--name 'front end'`)).toEqual(["--name", "front end"]);
    expect(shlexSplit(`a"b c"d`)).toEqual(["ab cd"]);
  });

  it("handles backslash escapes inside and outside double quotes", () => {
    expect(shlexSplit(String.raw`a\ b`)).toEqual(["a b"]);
    expect(shlexSplit(String.raw`"a\"b"`)).toEqual(['a"b']);
    expect(shlexSplit(String.raw`"a\\b"`)).toEqual([String.raw`a\b`]);
    expect(shlexSplit(String.raw`'a\b'`)).toEqual([String.raw`a\b`]); // single quotes keep backslashes
  });

  it("rejects an unterminated quote", () => {
    expect(() => shlexSplit(`--name "oops`)).toThrow(SyntaxError);
  });

  it("drops a trailing backslash at the end of input", () => {
    expect(shlexSplit("abc\\")).toEqual(["abc"]);
  });
});
