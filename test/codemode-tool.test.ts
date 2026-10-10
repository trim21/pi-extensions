import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { createCodemodeTools } from "../src/codemode/tool.js";
import { createReadsState } from "../src/lib/file-reads.js";
import { createRequestPolicy } from "../src/lib/request-policy.js";
import {
  createToolBus,
  defineStructuredTool,
  type StructuredResult,
  type ToolBus,
} from "../src/lib/tool-bus.js";

interface Harness {
  bus: ToolBus;
  codemode: ToolDefinition;
  select: ReturnType<typeof vi.fn>;
  appended: { customType: string; data: unknown }[];
  readTool: ReturnType<typeof vi.fn>;
  editTool: ReturnType<typeof vi.fn>;
  echoTool: ReturnType<typeof vi.fn>;
  textOnlyTool: ReturnType<typeof vi.fn>;
  spawnAgentTool: ReturnType<typeof vi.fn>;
  searchTool: ReturnType<typeof vi.fn>;
  brokenTool: ReturnType<typeof vi.fn>;
}

/** 缺省的审批回答（本测试用来断言 codemode 不调用它）。 */
async function approveOnce(): Promise<string> {
  return "Approve once";
}

/** 无订阅、无广播的事件总线桩。 */
function noopUnsubscribe(): void {}

const noopEvents = { on: () => noopUnsubscribe, emit: () => {} };

async function harness(
  options: {
    active?: string[];
    codemodeOnly?: string[];
    register?: (bus: ToolBus, pi: ExtensionAPI) => void;
  } = {},
): Promise<Harness> {
  const registered = new Map<string, ToolDefinition>();
  const appended: { customType: string; data: unknown }[] = [];
  const active = options.active ?? ["Read", "Edit", "echo", "text-only", "search", "broken"];
  const select = vi.fn(approveOnce);

  const pi = {
    registerTool: (tool: ToolDefinition) => registered.set(tool.name, tool),
    getActiveTools: () => active,
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data });
    },
    on: vi.fn(),
    events: noopEvents,
  } as unknown as ExtensionAPI;

  const readTool = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "file content" }],
    details: {},
  }));
  const editTool = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "edited" }],
    details: {},
  }));

  // 声明了 schema 的工具：脚本拿到解包后的载荷
  const echoTool = vi.fn(async (_id: string, params: { message: string }) => ({
    content: [{ type: "text" as const, text: `echo: ${params.message}` }],
    details: {},
    structuredResult: { ok: true as const, value: { message: `echo: ${params.message}` } },
  }));

  // 声明了 schema、但只给了文本（还没有结构化结果的工具），脚本拿文本——覆盖回退路径
  const textOnlyTool = vi.fn(async (_id: string, params: { message: string }) => ({
    content: [{ type: "text" as const, text: `plain: ${params.message}` }],
    details: {},
  }));

  const spawnAgentTool = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "subagent output" }],
    details: {},
  }));

  const searchTool = vi.fn(async (_id: string, params: { query: string }) =>
    params.query === "fail"
      ? {
          content: [{ type: "text" as const, text: "nothing matched" }],
          details: {},
          structuredResult: { ok: false as const, error: "nothing matched" },
        }
      : {
          content: [{ type: "text" as const, text: "2 files" }],
          details: {},
          structuredResult: {
            ok: true as const,
            value: { files: ["/tmp/a", "/tmp/b"], truncated: false },
          },
        },
  );

  const brokenTool = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "broken" }],
    details: {},
    // 故意绕过编译期检查：验证总线在运行期也会复核 structuredResult 与 structuredSchema
    structuredResult: {
      ok: true,
      value: { files: "not an array" },
    } as unknown as StructuredResult<{ files: string[] }>,
  }));

  const bus = createToolBus(pi, {
    isCodemodeOnly: (name) => options.codemodeOnly?.includes(name) ?? false,
  });
  bus.register({
    name: "Read",
    label: "Read",
    description: "read a file",
    parameters: Type.Object({ file_path: Type.String() }),
    execute: readTool,
  });
  bus.register({
    name: "Edit",
    label: "Edit",
    description: "edit a file",
    parameters: Type.Object({
      file_path: Type.String(),
      old_string: Type.String(),
      new_string: Type.String(),
    }),
    execute: editTool,
  });
  bus.register({
    name: "spawn-agent",
    label: "spawn-agent",
    description: "delegate to a subagent",
    parameters: Type.Object({ agent: Type.String(), task: Type.String() }),
    execute: spawnAgentTool,
  });
  bus.register(
    defineStructuredTool({
      name: "echo",
      label: "Echo",
      description: "echo a message back",
      parameters: Type.Object({ message: Type.String() }),
      structuredSchema: Type.Object({ message: Type.String() }),
      execute: echoTool,
    }),
  );
  bus.register(
    defineStructuredTool({
      name: "text-only",
      label: "Text only",
      description: "declares a schema but only returns text",
      parameters: Type.Object({ message: Type.String() }),
      structuredSchema: Type.Object({ message: Type.String() }),
      // 故意绕过编译期检查：验证「声明了 schema 却没给 structuredResult」时运行期的兜底
      execute: textOnlyTool as unknown as () => Promise<
        AgentToolResult<unknown> & { structuredResult: StructuredResult<{ message: string }> }
      >,
    }),
  );
  bus.register(
    defineStructuredTool({
      name: "search",
      label: "Search",
      description: "search files",
      parameters: Type.Object({ query: Type.String() }),
      structuredSchema: Type.Object({
        files: Type.Array(Type.String()),
        truncated: Type.Boolean(),
      }),
      execute: searchTool,
    }),
  );
  bus.register(
    defineStructuredTool({
      name: "broken",
      label: "Broken",
      description: "returns a payload that does not match its schema",
      parameters: Type.Object({}),
      structuredSchema: Type.Object({ files: Type.Array(Type.String()) }),
      execute: brokenTool,
    }),
  );

  // 额外注册的工具要在 codemode 之前进总线：可调用集合与描述在注册时确定
  options.register?.(bus, pi);

  await createCodemodeTools(pi).register(bus, {
    policy: createRequestPolicy(),
    reads: createReadsState(),
  });
  const codemode = registered.get("codemode");
  if (!codemode) {
    throw new Error("codemode tool was not registered");
  }
  return {
    bus,
    codemode,
    select,
    appended,
    readTool,
    editTool,
    echoTool,
    textOnlyTool,
    spawnAgentTool,
    searchTool,
    brokenTool,
  };
}

function context(select: ReturnType<typeof vi.fn>, branch: unknown[] = []): ExtensionToolContext {
  return {
    cwd: "/tmp",
    model: { id: "gpt-5.6" },
    ui: {
      select,
      input: vi.fn(),
      notify: vi.fn(),
      setStatus: vi.fn(),
      theme: { fg: (_c: string, t: string) => t },
    },
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionToolContext;
}

function textOf(result: { content: unknown }): string {
  return (result.content as { type: string; text?: string }[])
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
}

/** 分支上一条 codemode 的 toolResult：store 从这里重放。 */
function toolResultEntry(store: { set: Record<string, unknown>; delete: string[] }): unknown {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "codemode", details: { store } },
  };
}

interface ToolResultShape {
  content: unknown;
  details?: unknown;
  isError?: boolean;
}

interface PendantShape {
  title?: string;
  subtitle?: string;
  markdown?: string;
}

/** 一次 toolcall 进度更新：content 的文本与面板。 */
interface ProgressUpdate {
  text: string;
  pendant?: PendantShape;
}

function pendantOf(result: ToolResultShape): PendantShape {
  return (result.details as { pendant: PendantShape }).pendant;
}

async function runScript(
  h: Harness,
  code: string,
  branch: unknown[] = [],
  signal?: AbortSignal,
  onUpdate?: (update: ProgressUpdate) => void,
): Promise<ToolResultShape> {
  const result = await h.codemode.execute(
    "call-1",
    { code },
    signal,
    onUpdate
      ? (update: { content: unknown; details?: unknown }) =>
          onUpdate({
            text: textOf(update),
            pendant: (update.details as { pendant?: PendantShape } | undefined)?.pendant,
          })
      : undefined,
    context(h.select, branch),
  );
  return result;
}

describe("codemode 工具", () => {
  it("面板同时给出脚本输入与文本输出", async () => {
    const h = await harness();
    const result = await runScript(h, `text("hi");\nreturn 1;`);
    const pendant = pendantOf(result);

    expect(pendant.title).toBe("codemode");
    expect(pendant.markdown).toBe(
      '## Input\n```js\ntext("hi");\nreturn 1;\n```\n\n## Output\n```\nhi\n```',
    );
    expect(pendant.subtitle).toBe("0 tool call(s) · 2 chars output");
  });

  it("没有文本输出时省略 Output 段，字符数为 0", async () => {
    const h = await harness();
    const result = await runScript(h, "return 1;");
    const pendant = pendantOf(result);

    expect(pendant.markdown).toBe("## Input\n```js\nreturn 1;\n```");
    expect(pendant.subtitle).toBe("0 tool call(s) · 0 chars output");
  });

  it("脚本与输出里有反引号时各段用自己的围栏", async () => {
    const h = await harness();
    const backticks = "`".repeat(3);
    const result = await runScript(h, `const s = ${JSON.stringify(backticks)};\ntext(s);`);
    const pendant = pendantOf(result);

    expect(pendant.markdown?.startsWith("## Input\n````js\n")).toBe(true);
    expect(
      pendant.markdown?.endsWith(`## Output\n${"`".repeat(4)}\n${backticks}\n${"`".repeat(4)}`),
    ).toBe(true);
    expect(pendant.subtitle).toBe("0 tool call(s) · 3 chars output");
  });

  it("输出超过结果预算时面板仍给完整文本", async () => {
    const h = await harness();
    const result = await runScript(h, 'text("x".repeat(45000));');

    expect(textOf(result)).toContain("Warning: truncated output");
    expect(pendantOf(result).markdown?.endsWith(`${"x".repeat(45000)}\n\`\`\``)).toBe(true);
    expect(pendantOf(result).subtitle).toBe("0 tool call(s) · 45000 chars output");
  });

  it("进度更新里输出段累计、副标题带累计字符数", async () => {
    const h = await harness();
    const updates: ProgressUpdate[] = [];
    const result = await runScript(
      h,
      `text("a");\nawait call("echo", { message: "x" });\ntext("b");`,
      [],
      undefined,
      (update) => {
        updates.push(update);
      },
    );

    const first = updates.find((update) => update.text === "a");
    expect(first?.pendant?.markdown?.endsWith("## Output\n```\na\n```")).toBe(true);
    expect(first?.pendant?.subtitle).toBe("a · 1 chars output");

    const started = updates.find((update) => update.text.startsWith("→ echo"));
    expect(started?.pendant?.subtitle).toContain("→ echo");
    expect(started?.pendant?.subtitle).toContain("1 chars output");

    const second = updates.find((update) => update.text === "b");
    expect(second?.pendant?.markdown?.endsWith("## Output\n```\na\nb\n```")).toBe(true);
    expect(second?.pendant?.subtitle).toBe("b · 3 chars output");

    expect(pendantOf(result).subtitle).toBe("1 tool call(s) · 3 chars output");
  });

  it("失败脚本的面板保留已产生的输出与字符数", async () => {
    const h = await harness();
    const result = await runScript(h, `text("partial");\nthrow new Error("boom");`);

    expect(result.isError).toBe(true);
    expect(pendantOf(result).subtitle).toBe("failed (script) · 7 chars output");
    expect(pendantOf(result).markdown?.endsWith("## Output\n```\npartial\n```")).toBe(true);
  });

  it("非法 @options 的面板只有输入段、字符数为 0", async () => {
    const h = await harness();
    const result = await runScript(h, `// @options: {"nope": 1}\ntext("hi");`);

    expect(result.isError).toBe(true);
    expect(pendantOf(result).subtitle).toBe("invalid @options · 0 chars output");
    expect(pendantOf(result).markdown).toBe(
      '## Input\n```js\n// @options: {"nope": 1}\ntext("hi");\n```',
    );
  });

  it("描述里只列出声明了结构化输出的工具", async () => {
    const h = await harness();

    // 有 structuredSchema 的：进了可调用集合
    for (const name of ["echo", "search", "text-only", "broken"]) {
      expect(h.codemode.description).toContain(`declare function call(name: "${name}", args:`);
    }
    // 没有 schema 的（含 codemode 自己、spawn-agent、文件工具）：既不列出也不可调用
    for (const name of ["codemode", "spawn-agent", "Read", "Edit"]) {
      expect(h.codemode.description).not.toContain(`declare function call(name: "${name}"`);
    }
  });

  it("文件工具不进可调用集合：脚本改用 fs 原语", async () => {
    const h = await harness();

    for (const name of ["Read", "Edit"]) {
      expect(h.codemode.description).not.toContain(`declare function call(name: "${name}"`);
    }

    const result = await runScript(
      h,
      `try {
         await call("Read", { file_path: "/tmp/a" });
         return "called";
       } catch (error) {
         return [error instanceof CallFailedError, error.message].join("|");
       }`,
    );

    expect(textOf(result)).toContain(
      String.raw`"true|Tool \"Read\" is not available in codemode."`,
    );
    expect(h.readTool).not.toHaveBeenCalled();
  });

  it("描述里按 structuredSchema 渲染返回类型", async () => {
    const h = await harness();

    expect(h.codemode.description).toContain(
      'declare function call(name: "echo", args: {\n  message: string;\n}): Promise<{\n  message: string;\n}>;',
    );
    expect(h.codemode.description).toContain(
      'declare function call(name: "search", args: {\n  query: string;\n}): Promise<{\n  files: Array<string>;\n  truncated: boolean;\n}>;',
    );
    expect(h.codemode.description).toContain(
      "declare function call(name: string, args?: unknown): Promise<unknown>;",
    );
    expect(h.codemode.description).toContain("declare class CallFailedError extends Error");
  });

  it("声明了结构化输出却没给载荷时，脚本拿到 CallFailedError", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `try {
         await call("text-only", { message: "hi" });
         return "called";
       } catch (error) {
         return [error instanceof CallFailedError, error.message].join("|");
       }`,
    );

    expect(h.textOnlyTool).toHaveBeenCalledOnce();
    // 运行时复核由总线负责：声明了 schema 就必须要给结构化载荷
    expect(textOf(result)).toContain(
      "declared a structuredSchema but returned no structuredResult",
    );
  });

  it("描述里有 fs 原语的声明，但它们不是可调用工具", async () => {
    const h = await harness();

    expect(h.codemode.description).toContain(
      [
        "declare const fs: {",
        "  read(path: string): Promise<string>;",
        "  write(path: string, content: string): Promise<void>;",
        "};",
      ].join("\n"),
    );
    // fs 是内建能力：既不在 call 重载里，也不在 ALL_TOOLS 里
    expect(h.codemode.description).not.toContain('declare function call(name: "fs.read"');
    const result = await runScript(
      h,
      `return [typeof fs.read, ALL_TOOLS.some((tool) => tool.name.startsWith("fs."))].join("|");`,
    );
    expect(textOf(result)).toContain('"function|false"');
  });

  it("描述里不列出 spawn-agent", async () => {
    const h = await harness({ active: ["Read", "Edit", "spawn-agent"] });

    expect(h.codemode.description).not.toContain("spawn-agent");
  });

  it("脚本不可调用 spawn-agent", async () => {
    const h = await harness({ active: ["Read", "Edit", "spawn-agent"] });
    const result = await runScript(
      h,
      `try {
  await call("spawn-agent", { agent: "explorer", task: "look around" });
  return "called";
} catch (error) {
  return "failed: " + error.message;
}`,
    );

    expect(h.spawnAgentTool).not.toHaveBeenCalled();
    expect(textOf(result)).toContain("failed:");
    expect(textOf(result)).not.toContain("called");
  });

  it("描述里给出 store 的三个方法", async () => {
    const h = await harness();
    expect(h.codemode.description).toContain("declare const store:");
    expect(h.codemode.description).toContain("set(key: string, value: unknown): void");
    expect(h.codemode.description).toContain("get(key: string): unknown");
    expect(h.codemode.description).toContain("list(): string[]");
  });

  it("嵌套调用走工具总线，工具拿到 ctx 与结果回给脚本", async () => {
    const h = await harness();
    const result = await runScript(h, `return await call("echo", { message: "hi" });`);

    expect(h.echoTool).toHaveBeenCalledOnce();
    expect(h.echoTool.mock.calls[0]?.[0]).toBeTypeOf("string");
    expect(h.echoTool.mock.calls[0]?.[1]).toEqual({ message: "hi" });
    expect(h.echoTool.mock.calls[0]?.[4]).toMatchObject({ cwd: "/tmp" });
    expect(textOf(result)).toContain("echo: hi");
  });

  it("codemode 不额外加确认层：写类调用直接执行", async () => {
    const h = await harness();
    const result = await runScript(h, `await call("echo", { message: "x" }); return "done";`);

    expect(h.select).not.toHaveBeenCalled();
    expect(h.echoTool).toHaveBeenCalledOnce();
    expect(textOf(result)).toContain("done");
  });

  it("总线上的参数校验生效：参数不合法在脚本内报错", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `
      try {
        await call("echo", {});
        return "not reached";
      } catch (error) {
        return "caught: " + error.message;
      }
      `,
    );

    expect(h.echoTool).not.toHaveBeenCalled();
    // 返回值是字符串，会被 JSON 化（引号/转义），这里只断言关键内容
    expect(textOf(result)).toContain("caught: Invalid arguments for tool");
    expect(textOf(result)).toContain("must have required properties");
  });

  it("未 active 的工具在脚本里不可调用", async () => {
    const h = await harness({ active: ["Read"] });
    const result = await runScript(h, `return await call("echo", { message: "hi" });`);

    expect(result.isError).toBe(true);
    expect(h.echoTool).not.toHaveBeenCalled();
  });

  it("codemode-only 工具不在 active 列表里也进描述并可调用", async () => {
    const githubTool = vi.fn(async (_id: string, params: { repo?: string }) => ({
      content: [{ type: "text" as const, text: "repo info" }],
      details: {},
      structuredResult: { ok: true as const, value: { name: params.repo ?? "demo" } },
    }));
    const h = await harness({
      active: ["echo"],
      codemodeOnly: ["read-github-repo"],
      register: (bus) => {
        bus.register(
          defineStructuredTool({
            name: "read-github-repo",
            label: "GitHub Repo",
            description: "get repo info",
            parameters: Type.Object({ repo: Type.Optional(Type.String()) }),
            structuredSchema: Type.Object({ name: Type.String() }),
            execute: githubTool,
          }),
        );
      },
    });

    expect(h.codemode.description).toContain('declare function call(name: "read-github-repo"');

    const result = await runScript(h, `return await call("read-github-repo", { repo: "pi" });`);

    expect(result.isError).toBeFalsy();
    expect(githubTool).toHaveBeenCalledOnce();
    expect(textOf(result)).toContain('"name": "pi"');
  });

  it("脚本调用 codemode 自身被拒", async () => {
    const h = await harness();
    const result = await runScript(h, `return await call("codemode", { code: "return 1" });`);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Tool "codemode" is not available in codemode.');
  });

  it("带 structuredSchema 的工具把结构化结果交给脚本", async () => {
    const h = await harness();
    const result = await runScript(h, `return await call("search", { query: "a" });`);

    expect(h.searchTool).toHaveBeenCalledOnce();
    expect(textOf(result)).toContain('"files": [');
    expect(textOf(result)).toContain('"/tmp/a"');
    expect(textOf(result)).not.toContain("2 files");
  });

  it("结构化失败结果变成脚本里的 CallFailedError", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `try {
  await call("search", { query: "fail" });
  return "not reached";
} catch (error) {
  return [error instanceof CallFailedError, error.name, error.message].join("|");
}`,
    );

    expect(textOf(result)).toContain('"true|CallFailedError|nothing matched"');
  });

  it("structuredResult 与 structuredSchema 不匹配时调用失败", async () => {
    const h = await harness();
    const result = await runScript(h, `return await call("broken", {});`);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not match its structuredSchema");
  });

  it("脚本里的 fs.read / fs.write 由宿主执行，已读记账随结果持久化", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codemode-fs-e2e-"));
    try {
      const source = join(dir, "source.txt");
      const target = join(dir, "target.txt");
      await writeFile(source, "hello", "utf8");

      const h = await harness();
      const result = await runScript(
        h,
        `const content = await fs.read(${JSON.stringify(source)});
         await fs.write(${JSON.stringify(target)}, content + " world");
         return content;`,
      );

      expect(textOf(result)).toContain("hello");
      expect(result.isError).toBeUndefined();
      expect(await readFile(target, "utf8")).toBe("hello world");
      // 读到的文件进同一份记账，并随工具结果持久化（重放分支时收回来）
      const reads = (result.details as { reads?: Record<string, unknown> }).reads ?? {};
      expect(Object.keys(reads)).toContain(await realpath(source));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fs 原语的失败在脚本里是 CallFailedError", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `try {
         await fs.read(${JSON.stringify(join(tmpdir(), "codemode-missing-file.txt"))});
         return "not reached";
       } catch (error) {
         return [error instanceof CallFailedError, error.name].join("|");
       }`,
    );

    expect(textOf(result)).toContain('"true|CallFailedError"');
  });

  it("store 写入落在工具结果的 details 上，并从分支的 toolResult 重放", async () => {
    const h = await harness();
    const written = await runScript(h, `store.set("seen", 7); return "ok";`);
    expect((written.details as { store?: unknown }).store).toEqual({
      set: { seen: 7 },
      delete: [],
    });
    expect(h.appended).toEqual([]);

    const h2 = await harness();
    const fromBranch = await runScript(h2, `return (store.get("seen") ?? 0) + 1;`, [
      toolResultEntry({ set: { seen: 41 }, delete: [] }),
    ]);
    expect(textOf(fromBranch)).toContain("42");
  });

  it("load 从分支读回时字符串与对象原样返回", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `return { name: store.get("name"), cfg: store.get("cfg") };`,
      [toolResultEntry({ set: { name: "Read", cfg: { parallel: true } }, delete: [] })],
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain('"name": "Read"');
    expect(textOf(result)).toContain('"parallel": true');
  });

  it("分支上其他工具的 toolResult 不参与 store 恢复", async () => {
    const h = await harness();
    const result = await runScript(h, `return typeof store.get("leaked");`, [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "Read",
          details: { store: { set: { leaked: 1 }, delete: [] } },
        },
      },
    ]);

    expect(textOf(result)).toContain("undefined");
  });

  it("失败脚本不写 store", async () => {
    const h = await harness();
    const result = await runScript(h, `store.set("k", 1); throw new Error("boom");`);
    expect(result.isError).toBe(true);
    expect((result.details as { store?: unknown }).store).toBeUndefined();
    expect(h.appended).toEqual([]);
  });

  it("非法 @options 直接失败且不执行脚本", async () => {
    const h = await harness();
    const result = await runScript(h, `// @options: {"nope": 1}\nreturn 1;`);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not support");
    expect(h.echoTool).not.toHaveBeenCalled();
  });

  it("脚本报错时保留部分输出与调用记录", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `await call("echo", { message: "hi" }); text("before"); throw new Error("boom");`,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("before");
    expect(textOf(result)).toContain("boom");
    expect(
      (result.details as { calls: { name: string }[] }).calls.map((call) => call.name),
    ).toEqual(["echo"]);
  });

  it("中止后结果带上已产生的输出", async () => {
    const h = await harness();
    const controller = new AbortController();
    // 等输出真的到了再中止，避免机器慢时 abort 先于脚本产出
    const pending = runScript(
      h,
      `text("hi"); while (true) {}`,
      [],
      controller.signal,
      (progress) => {
        if (progress.text.includes("hi")) {
          controller.abort();
        }
      },
    );
    const guard = setTimeout(() => controller.abort(), 10_000);
    const result = await pending;
    clearTimeout(guard);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("hi");
    expect(textOf(result)).toContain("aborted");
  });

  it("输出超预算时截断并落全文", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `// @options: {"max_output_tokens": 20}\ntext("x".repeat(5000)); return "done";`,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("truncated output");
    expect(textOf(result)).toContain("Full output:");
    expect((result.details as { fullOutputPath?: string }).fullOutputPath).toMatch(
      /pi-codemode-.*\.txt$/,
    );
  });
});

describe("Bash 的结构化结果与搜索工具的排除", () => {
  it("脚本不可调用搜索工具，描述里也不出现它们", async () => {
    const searchNames = ["Grep", "Glob", "grep", "glob"];
    const searchTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "matches" }],
      details: {},
    }));
    const h = await harness({
      active: searchNames,
      register: (bus) => {
        for (const name of searchNames) {
          bus.register({
            name,
            label: name,
            description: `${name} files`,
            parameters: Type.Object({ pattern: Type.String() }),
            execute: searchTool,
          });
        }
      },
    });

    for (const name of searchNames) {
      expect(h.codemode.description).not.toContain(`declare function call(name: "${name}"`);
    }

    const result = await runScript(
      h,
      `try {
         await call("Grep", { pattern: "x" });
         return "called";
       } catch (error) {
         return [error instanceof CallFailedError, error.message].join("|");
       }`,
    );

    expect(textOf(result)).toContain(
      String.raw`"true|Tool \"Grep\" is not available in codemode."`,
    );
    expect(searchTool).not.toHaveBeenCalled();
  });

  it("脚本用 Bash 拿退出码并据它分支", async () => {
    // 桩 Bash：载荷形状与真实工具一致（{ exitCode, output }，非零退出也是成功结果）
    const bashTool = vi.fn(async (_id: string, params: { command: string }) => ({
      content: [{ type: "text" as const, text: "Exit code 1" }],
      details: {},
      structuredResult: {
        ok: true as const,
        value: { exitCode: params.command === "rg needle" ? 1 : 0, output: "boom\n" },
      },
    }));
    const h = await harness({
      active: ["Bash"],
      register: (bus) => {
        bus.register(
          defineStructuredTool({
            name: "Bash",
            label: "Bash",
            description: "run a command",
            parameters: Type.Object({ command: Type.String() }),
            structuredSchema: Type.Object({
              exitCode: Type.Union([Type.Number(), Type.Null()]),
              output: Type.String(),
            }),
            execute: bashTool,
          }),
        );
      },
    });

    // 描述里按 schema 渲染返回类型
    expect(h.codemode.description).toContain('declare function call(name: "Bash"');
    expect(h.codemode.description).toContain("exitCode: number | null");

    const result = await runScript(
      h,
      `const { exitCode, output } = await call("Bash", { command: "rg needle" });
       return exitCode === 1 ? "no match: " + output.trim() : "other";`,
    );

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("no match: boom");
    expect(bashTool).toHaveBeenCalledTimes(1);
  });
});
