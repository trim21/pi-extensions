/**
 * Tests for the todowrite extension (opencode-style todo tool):
 * - normalizeTodos: content trim
 * - serializeTodos / buildTodoMarkdown / countOpen
 * - tool registration metadata
 * - execute: full-list replacement + pendant.markdown output
 */
import { describe, expect, it, vi } from "vitest";

import todowrite, {
  buildTodoMarkdown,
  buildTodoWidgetLines,
  countOpen,
  normalizeTodos,
  serializeTodos,
  type TodoInfo,
  TOOL_NAME,
} from "../src/todowrite.js";

interface MockCtx {
  ui: { setWidget: (key: string, lines: string[] | undefined) => void };
}

interface Tool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: { todos: TodoInfo[] },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: MockCtx,
  ) => Promise<{
    content: { type: string; text: string }[];
    details: { todos: TodoInfo[]; pendant: { markdown: string; expanded: boolean } };
  }>;
}

function loadTool(): { tool: Tool } {
  let tool: Tool | undefined;
  todowrite({
    registerTool: (def: Tool) => {
      tool = def;
    },
  } as never);
  return { tool: tool! };
}

const todo = (over: Partial<TodoInfo>): TodoInfo => ({
  content: "Write tests",
  status: "pending",
  priority: "medium",
  ...over,
});

function makeCtx(): MockCtx {
  return { ui: { setWidget: vi.fn() } };
}

describe("normalizeTodos", () => {
  it("trims content and returns a clean copy", () => {
    const input = [
      { content: "  Add dark mode  ", status: "in_progress" as const, priority: "high" as const },
      { content: "Run tests", status: "pending" as const, priority: "low" as const },
    ];
    expect(normalizeTodos(input)).toEqual([
      { content: "Add dark mode", status: "in_progress", priority: "high" },
      { content: "Run tests", status: "pending", priority: "low" },
    ]);
  });
});

describe("pure helpers", () => {
  it("countOpen counts non-completed tasks", () => {
    const todos = [
      todo({ status: "pending" }),
      todo({ status: "in_progress" }),
      todo({ status: "completed" }),
      todo({ status: "cancelled" }),
    ];
    // opencode 的标题计数只排除 completed，cancelled 仍计入
    expect(countOpen(todos)).toBe(3);
  });

  it("serializeTodos matches opencode's JSON.stringify(todos, null, 2)", () => {
    const todos = [todo({ content: "a" })];
    expect(serializeTodos(todos)).toBe(JSON.stringify(todos, null, 2));
  });

  it("buildTodoMarkdown renders one line per task with status mark and priority", () => {
    const todos = [
      todo({ content: "pending task", status: "pending", priority: "high" }),
      todo({ content: "doing", status: "in_progress", priority: "medium" }),
      todo({ content: "done", status: "completed", priority: "low" }),
      todo({ content: "dropped", status: "cancelled", priority: "low" }),
    ];
    expect(buildTodoMarkdown(todos)).toBe(
      [
        "## Tasks",
        "",
        "**3 open · 4 total**",
        "",
        "- [ ] pending task `high`",
        "- [ ] doing `medium`",
        "- [x] done `low`",
        "- [-] dropped `low`",
      ].join("\n"),
    );
  });

  it("buildTodoMarkdown handles an empty list", () => {
    expect(buildTodoMarkdown([])).toBe(
      ["## Tasks", "", "**0 open · 0 total**", "", "_No todos_"].join("\n"),
    );
  });

  it("buildTodoWidgetLines filters cancelled and keeps other tasks", () => {
    const todos = [
      todo({ content: "doing", status: "in_progress", priority: "high" }),
      todo({ content: "dropped", status: "cancelled", priority: "low" }),
      todo({ content: "done", status: "completed", priority: "medium" }),
    ];
    expect(buildTodoWidgetLines(todos)).toEqual(["- [ ] doing `high`", "- [x] done `medium`"]);
  });

  it("buildTodoWidgetLines returns undefined when all tasks are cancelled or the list is empty", () => {
    expect(buildTodoWidgetLines([])).toBeUndefined();
    expect(buildTodoWidgetLines([todo({ status: "cancelled" })])).toBeUndefined();
  });
});

describe("tool registration", () => {
  it("registers todowrite with the opencode parameter shape", () => {
    const { tool } = loadTool();
    expect(tool.name).toBe(TOOL_NAME);
    expect(tool.label).toBe("Todo Write");
    expect(tool.parameters).toBeDefined();
    expect(tool.description).toContain("REPLACES the entire todo list");
    expect(tool.description).toContain("pending");
    expect(tool.description).toContain("in_progress");
    expect(tool.description).toContain("completed");
    expect(tool.description).toContain("cancelled");
  });
});

describe("execute", () => {
  it("replaces the list and returns JSON content plus a pendant markdown", async () => {
    const { tool } = loadTool();
    const ctx = makeCtx();

    const first = [todo({ content: "one", status: "in_progress", priority: "high" })];
    const result1 = await tool.execute("id-1", { todos: first }, undefined, undefined, ctx);
    expect(result1.content[0].text).toBe(JSON.stringify(first, null, 2));
    expect(result1.details.todos).toEqual(first);
    expect(result1.details.pendant.expanded).toBe(false);
    expect(result1.details.pendant.markdown).toBe(
      ["## Tasks", "", "**1 open · 1 total**", "", "- [ ] one `high`"].join("\n"),
    );
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(TOOL_NAME, ["- [ ] one `high`"]);

    // 第二次调用整体替换，不再包含第一条
    const second = [todo({ content: "two", status: "completed", priority: "low" })];
    const result2 = await tool.execute("id-2", { todos: second }, undefined, undefined, ctx);
    expect(result2.details.todos).toEqual(second);
    expect(result2.content[0].text).toBe(JSON.stringify(second, null, 2));
    expect(result2.details.pendant.markdown).toContain("- [x] two `low`");
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(TOOL_NAME, ["- [x] two `low`"]);
  });

  it("renders an empty pendant and clears the widget for an empty list", async () => {
    const { tool } = loadTool();
    const ctx = makeCtx();
    const result = await tool.execute("id", { todos: [] }, undefined, undefined, ctx);
    expect(result.content[0].text).toBe("[]");
    expect(result.details.todos).toEqual([]);
    expect(result.details.pendant.markdown).toContain("_No todos_");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(TOOL_NAME, undefined);
  });

  it("clears the widget when all tasks are cancelled", async () => {
    const { tool } = loadTool();
    const ctx = makeCtx();
    const todos = [todo({ content: "dropped", status: "cancelled", priority: "low" })];
    await tool.execute("id", { todos }, undefined, undefined, ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(TOOL_NAME, undefined);
  });
});
