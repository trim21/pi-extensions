import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { createCodemodeTools } from "../src/codemode/tool.js";
import { createToolBus, type ToolBus } from "../src/lib/tool-bus.js";

interface Harness {
  bus: ToolBus;
  codemode: ToolDefinition;
  select: ReturnType<typeof vi.fn>;
  appended: { customType: string; data: unknown }[];
  readTool: ReturnType<typeof vi.fn>;
  editTool: ReturnType<typeof vi.fn>;
}

/** 缺省的审批回答（本测试用来断言 codemode 不调用它）。 */
async function approveOnce(): Promise<string> {
  return "Approve once";
}

/** 无订阅、无广播的事件总线桩。 */
function noopUnsubscribe(): void {}

const noopEvents = { on: () => noopUnsubscribe, emit: () => {} };

async function harness(options: { active?: string[] } = {}): Promise<Harness> {
  const registered = new Map<string, ToolDefinition>();
  const appended: { customType: string; data: unknown }[] = [];
  const active = options.active ?? ["Read", "Edit"];
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

  const bus = createToolBus(pi);
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

  await createCodemodeTools(pi).register(bus);
  const codemode = registered.get("codemode");
  if (!codemode) {
    throw new Error("codemode tool was not registered");
  }
  return { bus, codemode, select, appended, readTool, editTool };
}

function context(select: ReturnType<typeof vi.fn>, branch: unknown[] = []): ExtensionContext {
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
  } as unknown as ExtensionContext;
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

async function runScript(
  h: Harness,
  code: string,
  branch: unknown[] = [],
  signal?: AbortSignal,
  onUpdate?: (text: string) => void,
): Promise<ToolResultShape> {
  const result = await h.codemode.execute(
    "call-1",
    { code },
    signal,
    onUpdate ? (update: { content: unknown }) => onUpdate(textOf(update)) : undefined,
    context(h.select, branch),
  );
  return result;
}

describe("codemode 工具", () => {
  it("面板正文是脚本原文，包在 js 代码块里", async () => {
    const h = await harness();
    const result = await runScript(h, `text("hi");\nreturn 1;`);
    const pendant = (
      result.details as { pendant: { title: string; subtitle: string; markdown: string } }
    ).pendant;

    expect(pendant.title).toBe("codemode");
    expect(pendant.markdown).toBe('```js\ntext("hi");\nreturn 1;\n```');
  });

  it("脚本里有反引号时用更长的围栏", async () => {
    const h = await harness();
    const fence = "`".repeat(3);
    const result = await runScript(h, `const s = ${JSON.stringify(fence)};\nreturn s;`);
    const markdown = (result.details as { pendant: { markdown: string } }).pendant.markdown;

    expect(markdown.startsWith("````js\n")).toBe(true);
    expect(markdown.endsWith("\n````")).toBe(true);
  });

  it("描述里列出可调用工具，且不含自己", async () => {
    const h = await harness();
    expect(h.codemode.description).toContain("Read(args:");
    expect(h.codemode.description).toContain("Edit(args:");
    expect(h.codemode.description).not.toContain("codemode(args:");
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
    const result = await runScript(h, `return await tools.Read({ file_path: "/tmp/a" });`);

    expect(h.readTool).toHaveBeenCalledOnce();
    expect(h.readTool.mock.calls[0]?.[0]).toBeTypeOf("string");
    expect(h.readTool.mock.calls[0]?.[1]).toEqual({ file_path: "/tmp/a" });
    expect(h.readTool.mock.calls[0]?.[4]).toMatchObject({ cwd: "/tmp" });
    expect(textOf(result)).toContain("file content");
  });

  it("codemode 不额外加确认层：写类工具直接执行", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `await tools.Edit({ file_path: "/tmp/a", old_string: "x", new_string: "y" }); return "done";`,
    );

    expect(h.select).not.toHaveBeenCalled();
    expect(h.editTool).toHaveBeenCalledOnce();
    expect(textOf(result)).toContain("done");
  });

  it("总线上的参数校验生效：参数不合法在脚本内报错", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `
      try {
        await tools.Edit({ file_path: "/tmp/a" });
        return "not reached";
      } catch (error) {
        return "caught: " + error.message;
      }
      `,
    );

    expect(h.editTool).not.toHaveBeenCalled();
    // 返回值是字符串，会被 JSON 化（引号/转义），这里只断言关键内容
    expect(textOf(result)).toContain("caught: Invalid arguments for tool");
    expect(textOf(result)).toContain("must have required properties");
  });

  it("未 active 的工具在脚本里不可调用", async () => {
    const h = await harness({ active: ["Read"] });
    const result = await runScript(h, `return await tools.Edit({ file_path: "/tmp/a" });`);

    expect(result.isError).toBe(true);
    expect(h.editTool).not.toHaveBeenCalled();
  });

  it("脚本调用 codemode 自身被拒", async () => {
    const h = await harness();
    const result = await runScript(h, `return await tools.codemode({ code: "return 1" });`);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not a function");
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
    expect(h.readTool).not.toHaveBeenCalled();
  });

  it("脚本报错时保留部分输出与调用记录", async () => {
    const h = await harness();
    const result = await runScript(
      h,
      `await tools.Read({ file_path: "/tmp/a" }); text("before"); throw new Error("boom");`,
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("before");
    expect(textOf(result)).toContain("boom");
    expect(
      (result.details as { calls: { name: string }[] }).calls.map((call) => call.name),
    ).toEqual(["Read"]);
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
        if (progress.includes("hi")) {
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
