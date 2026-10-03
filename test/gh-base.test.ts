/**
 * Tests for the result shaping and `gh` subprocess layer in `src/gh/base.ts`.
 *
 * Regression: `gh --json` prints a single line of JSON, and line-based
 * truncation blanked any payload over the byte budget entirely (see
 * `test/pr.test.ts` for the tool-level symptom). JSON output must pass through
 * whole; text truncation must never blank non-empty input; a `gh` killed by an
 * external signal must not report success.
 *
 * Run: npx vitest run test/gh-base.test.ts
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import {
  ghExec,
  structuredFailure,
  toStructuredJsonResult,
  toToolResult,
  toToolResultJson,
  truncate,
  withStructuredResult,
} from "../src/gh/base.js";

class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    return true;
  }

  close(code: number | null): void {
    this.emit("close", code);
  }
}

describe("truncate", () => {
  it("returns text within the limits untouched", () => {
    expect(truncate("a\nb", 10, 100)).toEqual({ text: "a\nb", truncated: false });
  });

  it("keeps whole lines up to the byte budget", () => {
    const text = ["a".repeat(9), "b".repeat(9), "c"].join("\n");
    expect(truncate(text, 10, 20)).toEqual({
      text: ["a".repeat(9), "b".repeat(9)].join("\n"),
      truncated: true,
    });
  });

  it("never blanks non-empty input whose first line exceeds the byte budget", () => {
    const { text, truncated } = truncate("x".repeat(100), 10, 10);
    expect(truncated).toBe(true);
    expect(text).toBe("x".repeat(10));
  });
});

describe("toToolResultJson", () => {
  it("passes an over-budget single-line JSON payload through whole", () => {
    const json = JSON.stringify({ number: 142, body: "x".repeat(80 * 1024) });
    const result = toToolResultJson(json, { number: 142 });
    expect(result.content[0].text).toBe(json);
    expect(result.details).toEqual({ input: { number: 142 }, truncated: false });
  });
});

describe("toToolResult", () => {
  it("truncates text output but keeps it non-empty", () => {
    const result = toToolResult("x".repeat(80 * 1024));
    expect(result.details.truncated).toBe(true);
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

describe("ghExec", () => {
  it("treats a gh killed by an external signal as a failure", async () => {
    spawnMock.mockImplementation(() => {
      const proc = new FakeChildProcess();
      queueMicrotask(() => proc.close(null));
      return proc;
    });

    await expect(ghExec(["pr", "view", "1"], {})).rejects.toThrow("exit code -1");
  });
});

/** 结构化结果：文本与 details 保持原样，结构化载荷单独放在 structuredResult 里。 */
const issueSchema = Type.Object({ number: Type.Number(), title: Type.String() });

describe("toStructuredJsonResult", () => {
  it("keeps the JSON text and details untouched, and parses the value", () => {
    const json = JSON.stringify({ number: 142, title: "t", state: "OPEN" });
    const result = toStructuredJsonResult(json, { number: 142 }, issueSchema);

    expect(result.content[0].text).toBe(json);
    expect(result.details).toEqual({ input: { number: 142 }, truncated: false });
    // 额外字段保留：schema 只描述工具依赖的字段，不该削掉 GitHub 多给的字段
    expect(result.structuredResult).toEqual({
      ok: true,
      value: { number: 142, title: "t", state: "OPEN" },
    });
  });

  it("fails loudly when the payload does not match the schema", () => {
    const json = JSON.stringify({ number: "142", title: "t" });
    expect(() => toStructuredJsonResult(json, undefined, issueSchema)).toThrow(/number/);
  });
});

describe("withStructuredResult", () => {
  it("attaches the success value without touching content or details", () => {
    const base = toToolResult("some text");
    expect(withStructuredResult(base, { files: [] })).toEqual({
      ...base,
      structuredResult: { ok: true, value: { files: [] } },
    });
  });
});

describe("structuredFailure", () => {
  it("is the failure arm of a structured result", () => {
    expect(structuredFailure("nothing here")).toEqual({ ok: false, error: "nothing here" });
  });
});
