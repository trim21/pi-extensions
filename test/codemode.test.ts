import { describe, expect, it, vi } from "vitest";

import { createCodemodeSandbox, type SandboxRunOptions } from "../src/codemode/sandbox.js";

/** 建沙箱 + 跑一段脚本；onCall 缺省把参数原样回给脚本。 */
async function run(
  code: string,
  overrides: Partial<SandboxRunOptions> = {},
): Promise<Awaited<ReturnType<Awaited<ReturnType<typeof createCodemodeSandbox>>["run"]>>> {
  const sandbox = await createCodemodeSandbox();
  return await sandbox.run({
    code,
    tools: [{ name: "Read", description: "read a file" }],
    store: {},
    timeoutMs: 10_000,
    onCall: async ({ args }) => ({ ok: true, value: { echoed: args } }),
    ...overrides,
  });
}

describe("codemode 沙箱", () => {
  it("工具调用、输出、返回值与 store 写入", async () => {
    const result = await run(
      `
      const file = await tools.Read({ path: "a.txt" });
      text("read " + file.echoed.path);
      store("last", file.echoed.path);
      console.log("done");
      return { path: file.echoed.path };
      `,
      { store: { runs: 1 } },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ path: "a.txt" });
      expect(result.writes.set).toEqual({ last: "a.txt" });
      expect(result.writes.delete).toEqual([]);
    }
    expect(result.output).toEqual([
      { type: "text", text: "read a.txt" },
      { type: "text", text: "done" },
    ]);
    expect(result.calls).toEqual([{ name: "Read", status: "ok", durationMs: expect.any(Number) }]);
  });

  it("load 能读到初始 store", async () => {
    const result = await run(`return (load("runs") ?? 0) + 1;`, { store: { runs: 41 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("工具报错以 Error 回到脚本，脚本可以捕获", async () => {
    const result = await run(
      `
      try {
        await tools.Read({ path: "missing" });
        return "not reached";
      } catch (error) {
        return "caught: " + error.message;
      }
      `,
      { onCall: async () => ({ ok: false, error: "ENOENT: no such file" }) },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("caught: ENOENT: no such file");
    }
    expect(result.calls[0]?.status).toBe("error");
  });

  it("不存在的工具是脚本错误", async () => {
    const result = await run(`return await tools.Nope();`);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.kind).toBe("script");
    // QuickJS 的报错文案与 V8 不同，只断言「调用不存在的东西」这一事实
    expect(result.error.message).toContain("not a function");
  });

  it("脚本抛错带 kind script", async () => {
    const result = await run(`throw new Error("boom");`);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.kind).toBe("script");
    expect(result.error.message).toContain("boom");
  });

  it("死循环被超时终止，保留已产生的输出", async () => {
    const onOutput = vi.fn();
    const result = await run(
      `
      text("before the loop");
      while (true) {}
      `,
      { timeoutMs: 1_000, onOutput },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("timeout");
    }
    expect(result.output).toEqual([{ type: "text", text: "before the loop" }]);
    expect(onOutput).toHaveBeenCalledWith([{ type: "text", text: "before the loop" }]);
  });

  it("中止信号终止脚本", async () => {
    const controller = new AbortController();
    // 用死循环而不是挂起的 promise：后者会被 stalled() 立刻判失败
    const pending = run(`while (true) {}`, { signal: controller.signal, timeoutMs: 30_000 });
    setTimeout(() => controller.abort(), 200);

    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
  });

  it("等一个永远不会 settle 的 promise 立刻失败", async () => {
    const result = await run(`await new Promise(() => {});`);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.kind).toBe("script");
    expect(result.error.message).toContain("can never settle");
  });

  it("exit() 立刻结束并保留输出与 store", async () => {
    const result = await run(`
      text("bye");
      store("k", 1);
      exit();
      text("never");
    `);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
      expect(result.writes.set).toEqual({ k: 1 });
    }
    expect(result.output).toEqual([{ type: "text", text: "bye" }]);
  });

  it("VM 里没有宿主能力", async () => {
    const result = await run(`
      return {
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        setTimeout: typeof setTimeout,
        evaluate: typeof globalThis.eval,
      };
    `);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        process: "undefined",
        require: "undefined",
        fetch: "undefined",
        setTimeout: "undefined",
        // eval 仍可用，但只能产出同一个 VM 里的代码
        evaluate: "function",
      });
    }
  });

  it("工具名里的非法标识符也能调用", async () => {
    const result = await run(
      `
      const a = await tools["read-github-pr"]({ number: 1 });
      const b = await tools.read_github_pr({ number: 2 });
      return [a.echoed.number, b.echoed.number].join(",");
      `,
      { tools: [{ name: "read-github-pr" }] },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("1,2");
    }
  });
});
