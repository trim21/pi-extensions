/**
 * Tests for the command-line argument parser used by /command handlers.
 */
import { describe, expect, it } from "vitest";

import { parseArgs, shlexSplit } from "../src/lib/cli-args.js";

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

describe("parseArgs", () => {
  it("splits a raw string before parsing flags", () => {
    const parsed = parseArgs(`abc --name frontend`);
    expect(parsed.positionals).toEqual(["abc"]);
    expect(parsed.flags).toEqual({ name: "frontend" });
  });

  it("accepts a pre-tokenized array", () => {
    const parsed = parseArgs(["abc", "--name", "frontend"]);
    expect(parsed.positionals).toEqual(["abc"]);
    expect(parsed.flags).toEqual({ name: "frontend" });
  });

  it("supports --flag=value and bare boolean flags", () => {
    expect(parseArgs("--name=frontend").flags).toEqual({ name: "frontend" });
    expect(parseArgs("--force").flags).toEqual({ force: true });
  });

  it("consumes the next token as the flag value unless it is a flag", () => {
    expect(parseArgs("--name frontend extra").positionals).toEqual(["extra"]);
    expect(parseArgs("--name --force").flags).toEqual({ name: true, force: true });
    expect(parseArgs("--name").flags).toEqual({ name: true });
  });

  it("treats everything after -- as positional", () => {
    const parsed = parseArgs("-- --name not-a-flag");
    expect(parsed.positionals).toEqual(["--name", "not-a-flag"]);
    expect(parsed.flags).toEqual({});
  });
});
