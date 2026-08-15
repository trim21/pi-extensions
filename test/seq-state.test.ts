import { describe, expect, it } from "vitest";

import { createSeqState } from "../src/lib/seq-state.js";

describe("createSeqState", () => {
  it("serializes fn executions for the same key", async () => {
    const seq = createSeqState();
    let active = 0;
    let maxActive = 0;
    const fn = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      await Promise.resolve();
      active--;
    };

    await Promise.all([seq.execute("a", fn), seq.execute("a", fn), seq.execute("a", fn)]);
    expect(maxActive).toBe(1);
  });

  it("runs each caller's fn (no dedup), in submission order", async () => {
    const seq = createSeqState();
    const order: number[] = [];
    const results = await Promise.all([
      seq.execute("a", async () => {
        order.push(1);
        await Promise.resolve();
        return "first";
      }),
      seq.execute("a", async () => {
        order.push(2);
        return "second";
      }),
    ]);
    expect(results).toEqual(["first", "second"]);
    expect(order).toEqual([1, 2]);
  });

  it("runs different keys independently", async () => {
    const seq = createSeqState();
    const calls: string[] = [];
    await Promise.all([
      seq.execute("a", async () => {
        calls.push("a");
        return "a";
      }),
      seq.execute("b", async () => {
        calls.push("b");
        return "b";
      }),
    ]);
    expect(calls.toSorted()).toEqual(["a", "b"]);
  });

  it("keeps state isolated between instances", async () => {
    const first = createSeqState();
    const second = createSeqState();
    let active = 0;
    let maxActive = 0;
    const fn = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
    };
    await Promise.all([first.execute("k", fn), second.execute("k", fn)]);
    // 两个实例互不影响，同 key 也各自独立执行
    expect(maxActive).toBe(2);
  });

  it("cleans up after settling so a later call re-runs fn", async () => {
    const seq = createSeqState();
    let calls = 0;
    await expect(
      seq.execute("k", async () => {
        calls++;
        return "x";
      }),
    ).resolves.toBe("x");
    await expect(
      seq.execute("k", async () => {
        calls++;
        return "y";
      }),
    ).resolves.toBe("y");
    expect(calls).toBe(2);
  });

  it("continues after a failure (a rejection does not block later calls)", async () => {
    const seq = createSeqState();
    let calls = 0;
    const first = seq.execute("k", async () => {
      calls++;
      throw new Error("boom");
    });
    const second = seq.execute("k", async () => {
      calls++;
      return "ok";
    });
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});
