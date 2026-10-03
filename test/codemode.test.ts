/**
 * codemode 沙箱（src/codemode/sandbox.ts）的语义：脚本跑在 bwrap 里的 Node 子进程，
 * 协议走专用 fd，工具调用由宿主的 onCall 执行。
 *
 * 大部分用例需要真实 bwrap（先做一次最小探测，探测不过整组跳过——macOS、没有
 * bubblewrap 或受限 CI 环境不应报假失败）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { type BwrapConfigFile, findBwrap } from "../src/bwrap/core.js";
import { loadSandboxConfig } from "../src/bwrap/sandbox.js";
import {
  createCodemodeSandbox,
  type SandboxOutcome,
  type SandboxRunOptions,
  type SandboxView,
} from "../src/codemode/sandbox.js";

function bwrapUsable(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  let binary: string;
  try {
    binary = findBwrap();
  } catch {
    return false;
  }
  const probe = spawnSync(
    binary,
    [
      "--ro-bind",
      "/",
      "/",
      "--unshare-user",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--",
      "/bin/true",
    ],
    { timeout: 20000 },
  );
  return probe.status === 0;
}

const sandboxed = bwrapUsable();

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "codemode-sandbox-"));
}

/** 沙箱视图：写一份临时配置再解析，fs / network 模式可覆盖。 */
function view(
  dir: string,
  fsMode: "workspace-write" | "readonly" = "workspace-write",
  network: "allow-all" | "block" = "allow-all",
): SandboxView {
  const path = join(dir, "codemode-sandbox.json");
  const config: BwrapConfigFile = {
    fs: { mode: fsMode },
    // 缺省 allow-all：多数用例不需要网络栈（limited 的组装由 bwrap 层自己的用例覆盖）
    network: { mode: network },
  };
  writeFileSync(path, JSON.stringify(config));
  return {
    resolved: loadSandboxConfig({ workspace: dir, configPath: path }),
    bwrapUnavailable: false,
  };
}

/** 跑一段脚本；onCall 缺省把参数原样回给脚本。 */
async function run(
  code: string,
  overrides: Partial<SandboxRunOptions> = {},
): Promise<SandboxOutcome> {
  const dir = overrides.workspace ?? workspace();
  return await createCodemodeSandbox().run({
    code,
    tools: [{ name: "Read", description: "read a file" }],
    store: {},
    workspace: dir,
    sandbox: view(dir),
    onCall: async ({ args }) => ({ ok: true, value: { echoed: args } }),
    ...overrides,
  });
}

describe.skipIf(!sandboxed)("codemode 沙箱", () => {
  it("工具调用、输出、返回值与 store 写入", async () => {
    const result = await run(
      `
      const file = await call("Read", { path: "a.txt" });
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

  it("工具报错以 CallFailedError 回到脚本，脚本可以捕获", async () => {
    const result = await run(
      `
      try {
        await call("Read", { path: "missing" });
        return "not reached";
      } catch (error) {
        return [error instanceof CallFailedError, error.name, error.message].join(" | ");
      }
      `,
      { onCall: async () => ({ ok: false, error: "ENOENT: no such file" }) },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("true | CallFailedError | ENOENT: no such file");
    }
    expect(result.calls[0]?.status).toBe("error");
  });

  it("不存在的工具名以 CallFailedError 失败", async () => {
    const result = await run(`return await call("Nope");`);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.kind).toBe("script");
    expect(result.error.message).toContain('Tool "Nope" is not available in codemode.');
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
    const result = await run(`return await call("Read", { path: "slow" });`, {
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
    // 用死循环而不是挂起的 promise：后者会被卡死检测立刻判失败
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

  it("脚本是普通 Node 程序：内置模块可用，旧的 tools 对象不存在", async () => {
    const result = await run(`
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      return {
        process: typeof process,
        fetch: typeof fetch,
        setTimeout: typeof setTimeout,
        fs: typeof fs.readFile,
        path: typeof path.join,
        tools: typeof tools,
        call: typeof call,
        callFailedError: typeof CallFailedError,
      };
    `);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        process: "object",
        fetch: "function",
        setTimeout: "function",
        fs: "function",
        path: "function",
        tools: "undefined",
        call: "function",
        callFailedError: "function",
      });
    }
  });

  it("一次调用里同时用 node:fs、call() 与 store", async () => {
    const dir = workspace();
    const source = join(dir, "input.txt");
    const target = join(dir, "output.txt");
    await (await import("node:fs/promises")).writeFile(source, "input", "utf8");

    const result = await run(
      `
      const fs = await import("node:fs/promises");
      const input = await fs.readFile(${JSON.stringify(source)}, "utf8");
      const echoed = await call("Read", { path: input });
      await fs.writeFile(${JSON.stringify(target)}, echoed.echoed.path + "!");
      store.set("lastInput", input);
      return { input, tool: echoed.echoed.path, files: store.list() };
    `,
      { workspace: dir },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ input: "input", tool: "input", files: ["lastInput"] });
      expect(result.writes.set).toEqual({ lastInput: "input" });
    }
    expect(result.calls).toEqual([{ name: "Read", status: "ok", durationMs: expect.any(Number) }]);
    expect(await readFile(target, "utf8")).toBe("input!");
  });

  it("network 模式为 block 时脚本出网失败（不是静默成功）", async () => {
    const dir = workspace();
    const result = await run(
      `
      const net = await import("node:net");
      return await new Promise((resolve) => {
        const socket = net.connect({ host: "1.1.1.1", port: 443 });
        socket.on("connect", () => resolve("connected"));
        socket.on("error", (error) => resolve(error.code ?? error.message));
      });
    `,
      { workspace: dir, sandbox: view(dir, "workspace-write", "block") },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("ENETUNREACH");
    }
  });

  it("脚本用 node:fs 读写沙箱可写路径里的文件", async () => {
    const dir = workspace();
    const result = await run(
      `
      const fs = await import("node:fs/promises");
      await fs.writeFile(${JSON.stringify(join(dir, "note.txt"))}, "written by the script");
      return await fs.readFile(${JSON.stringify(join(dir, "note.txt"))}, "utf8");
    `,
      { workspace: dir },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("written by the script");
    }
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("written by the script");
  });

  it("只读沙箱：脚本写文件被拒绝（不是静默成功）", async () => {
    const dir = workspace();
    const result = await run(
      `
      const fs = await import("node:fs/promises");
      try {
        await fs.writeFile(${JSON.stringify(join(dir, "note.txt"))}, "nope");
        return "write succeeded";
      } catch (error) {
        return error.code;
      }
    `,
      { workspace: dir, sandbox: view(dir, "readonly") },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("EROFS");
    }
  });

  it("脚本直接写 stdout / stderr 的内容也进输出，协议不受影响", async () => {
    const result = await run(String.raw`
      process.stdout.write("to stdout\n");
      process.stderr.write("to stderr\n");
      const value = await call("Read", { path: "a.txt" });
      return value.echoed.path;
    `);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("a.txt");
    }
    const text = result.output
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("");
    expect(text).toContain("to stdout");
    expect(text).toContain("to stderr");
    expect(result.calls).toEqual([{ name: "Read", status: "ok", durationMs: expect.any(Number) }]);
  });

  it("脚本往协议 fd 写垃圾字节不影响调用（当脚本输出报出去）", async () => {
    const result = await run(`
      const fs = await import("node:fs");
      fs.writeSync(3, "not a frame at all");
      const value = await call("Read", { path: "a.txt" });
      return value.echoed.path;
    `);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("a.txt");
    }
    const text = result.output
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("");
    expect(text).toContain("not a frame at all");
  });

  it("工具名里的非法标识符按字符串调用，且不同名字互不干扰", async () => {
    const result = await run(
      `
      const a = await call("read-github-pr", { number: 1 });
      const b = await call("Read", { number: 2 });
      return [a.echoed.number, b.echoed.number, ALL_TOOLS.map((t) => t.name).join("+")].join(",");
      `,
      { tools: [{ name: "read-github-pr" }, { name: "Read" }] },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("1,2,read-github-pr+Read");
    }
  });

  it("动态工具名与未提供的参数", async () => {
    const result = await run(`return await call("Read");`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ echoed: undefined });
    }
  });

  it("每次执行都是新进程：脚本里的全局状态不跨调用保留", async () => {
    const first = await run(`globalThis.leak = "set"; return "ok";`);
    expect(first.ok).toBe(true);

    const second = await run(`return typeof globalThis.leak;`);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value).toBe("undefined");
    }
  });

  it("执行结束后不留下脚本子进程", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codemode-cleanup-"));
    await run(`return process.pid;`, { workspace: dir });
    // 子进程已被杀掉：它所在的进程组不再有进程
    const { execFileSync } = await import("node:child_process");
    const listing = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
    expect(listing).not.toContain("codemode/bootstrap.js");
    expect(listing).not.toContain(join(dir, "bootstrap.mjs"));
  });
});

describe("bootstrap 脚本产物", () => {
  /**
   * `bootstrap.js` 由 `node` 直接加载（不经 pi 的 jiti），因此解析不到 pi 提供的依赖：
   * 一旦引入第三方裸导入，用户装好包后就会报 `Cannot find package`（`worker.js` 的
   * typebox 事故就是这样）。源码只允许 `node:` 内置与类型导入，产物里因此只剩 node: 内置。
   */
  it("只 import node 内置模块", async () => {
    const source = await readFile(new URL("../src/codemode/bootstrap.js", import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/^\s*import\s[^"'`]*from\s*["']([^"']+)["']/gm)].map(
      (match) => match[1],
    );

    expect(specifiers).not.toEqual([]);
    expect(specifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
  });
});
