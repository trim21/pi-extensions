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
      store.set("last", file.echoed.path);
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

  it("store.get 能读到初始 store", async () => {
    const result = await run(`return (store.get("runs") ?? 0) + 1;`, { store: { runs: 41 } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it("store.list 返回升序键，被删除的键不再出现", async () => {
    const result = await run(`
      store.set("b", 1);
      store.set("a", 2);
      store.set("c", 3);
      store.set("b", undefined);
      return store.list();
    `);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(["a", "c"]);
    }
  });

  it("store.get 原样读回字符串、数组与对象（不是把值当 JSON 再解析一次）", async () => {
    const result = await run(
      `return { str: store.get("str"), numStr: store.get("numStr"), list: store.get("list"), nested: store.get("nested"), missing: typeof store.get("nope") };`,
      {
        store: {
          str: "CODEMODE_TOOL_NAME",
          numStr: "41",
          list: [1, "two"],
          nested: { a: [true, null] },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        str: "CODEMODE_TOOL_NAME",
        numStr: "41",
        list: [1, "two"],
        nested: { a: [true, null] },
        missing: "undefined",
      });
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

  it("死循环被中止终止，保留已产生的输出", async () => {
    const controller = new AbortController();
    // 等输出真的到了再中止：否则机器一慢，abort 会先于脚本产出而变成「无输出」
    const onOutput = vi.fn((items: readonly { type: string; text?: string }[]) => {
      if (items.some((item) => item.type === "text" && item.text?.includes("before the loop"))) {
        controller.abort();
      }
    });
    const pending = run(`text("before the loop");\nwhile (true) {}`, {
      signal: controller.signal,
      onOutput,
    });
    const guard = setTimeout(() => controller.abort(), 10_000);

    const result = await pending;
    clearTimeout(guard);
    expect(onOutput).toHaveBeenCalledWith([{ type: "text", text: "before the loop" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("aborted");
    }
    expect(result.output).toEqual([{ type: "text", text: "before the loop" }]);
  });

  it("等嵌套调用的时间不受任何时限约束", async () => {
    // 写类工具的确认框、Bash 提权都要人等；脚本没有超时，等多久都照常返回
    const result = await run(`return await tools.Read({ path: "slow" });`, {
      onCall: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return { ok: true, value: "slow result" };
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("slow result");
    }
  });

  it("中止信号终止脚本", async () => {
    const controller = new AbortController();
    // 用死循环而不是挂起的 promise：后者会被 stalled() 立刻判失败
    const pending = run(`while (true) {}`, { signal: controller.signal });
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
      store.set("k", 1);
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
