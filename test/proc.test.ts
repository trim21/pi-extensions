import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { forEachLine } from "../src/lib/proc.js";

describe("forEachLine", () => {
  it("行跨多个 chunk 时正确拼接", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["Tun adapter ", "listening at: X\n", "next line\n"]);
    await forEachLine(stream, (line) => {
      lines.push(line);
    });
    expect(lines).toEqual(["Tun adapter listening at: X", "next line"]);
  });

  it("单个 chunk 含多行", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["a\nb\nc\n"]);
    await forEachLine(stream, (line) => {
      lines.push(line);
    });
    expect(lines).toEqual(["a", "b", "c"]);
  });

  it("末尾无换行的行不回调", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["partial line"]);
    await forEachLine(stream, (line) => {
      lines.push(line);
    });
    expect(lines).toEqual([]);
  });

  it("回调返回 false 时提前停止消费", async () => {
    const lines: string[] = [];
    const stream = Readable.from(["a\n", "b\n", "c\n"]);
    await forEachLine(stream, (line) => {
      lines.push(line);
      return line !== "a";
    });
    expect(lines).toEqual(["a"]);
  });
});
