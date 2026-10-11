/**
 * Tests for the result shaping and `gh` subprocess layer in `src/gh/base.ts`.
 *
 * A `gh` killed by an external signal must not report success; the structured
 * result helpers must validate the value against the tool's schema loudly
 * (a schema drifting from GitHub's response must not silently drop fields).
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

import { ghExec, structuredFailure, structuredResult } from "../src/gh/base.js";

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

/** 结构化结果：数据只以 Result 信封交付，没有面向模型的 content / details。 */
const issueSchema = Type.Object({ number: Type.Number(), title: Type.String() });

describe("structuredResult", () => {
  it("parses the value against the schema and keeps extra fields", () => {
    const result = structuredResult(issueSchema, { number: 142, title: "t", state: "OPEN" });

    // 额外字段保留：schema 只描述工具依赖的字段，不该削掉 GitHub 多给的字段
    expect(result).toEqual({
      ok: true,
      value: { number: 142, title: "t", state: "OPEN" },
    });
  });

  it("fails loudly when the payload does not match the schema", () => {
    expect(() => structuredResult(issueSchema, { number: "142", title: "t" })).toThrow(/number/);
  });
});

describe("structuredFailure", () => {
  it("is the failure arm of a structured result", () => {
    expect(structuredFailure("nothing here")).toEqual({ ok: false, error: "nothing here" });
  });
});
