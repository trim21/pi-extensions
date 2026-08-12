/**
 * Tests for the todowrite extension (opencode-style todo tool):
 * - schema / type guards
 * - normalizeTodos: validation + full-list semantics
 * - serializeTodos / buildTodoMarkdown / countOpen
 * - tool registration metadata
 * - execute: full-list replacement + pendant.markdown output
 */
import { describe, expect, it } from "vitest";

import todowrite, {
  buildTodoMarkdown,
  countOpen,
  isTodoPriority,
  isTodoStatus,
  normalizeTodos,
  serializeTodos,
  TODO_STATUSES,
  type TodoInfo,
  TOOL_NAME,
} from "../src/todowrite.js";

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
    ctx: unknown,
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

describe("type guards", () => {
  it("accepts only the opencode status / priority values", () => {
    expect(isTodoStatus("pending")).toBe(true);
    expect(isTodoStatus("in_progress")).toBe(true);
    expect(isTodoStatus("completed")).toBe(true);
    expect(isTodoStatus("cancelled")).toBe(true);
    expect(isTodoStatus("deleted")).toBe(false);
    expect(isTodoStatus(42)).toBe(false);

    expect(isTodoPriority("high")).toBe(true);
    expect(isTodoPriority("medium")).toBe(true);
    expect(isTodoPriority("low")).toBe(true);
    expect(isTodoPriority("urgent")).toBe(false);
  });
});

describe("normalizeTodos", () => {
  it("returns a clean copy for valid input", () => {
    const input = [
      { content: "  Add dark mode  ", status: "in_progress", priority: "high" },
      { content: "Run tests", status: "pending", priority: "low" },
    ];
    expect(normalizeTodos(input)).toEqual([
      { content: "Add dark mode", status: "in_progress", priority: "high" },
      { content: "Run tests", status: "pending", priority: "low" },
    ]);
  });

  it("rejects a non-array", () => {
    expect(() => normalizeTodos({})).toThrow(/array/);
    expect(() => normalizeTodos(null)).toThrow(/array/);
  });

  it("rejects items missing content", () => {
    expect(() => normalizeTodos([{ status: "pending", priority: "low" }])).toThrow(
      /todos\[0\]\.content/,
    );
    expect(() =>
      normalizeTodos([{ content: " ".repeat(3), status: "pending", priority: "low" }]),
    ).toThrow(/todos\[0\]\.content/);
  });

  it("rejects invalid status and priority with context", () => {
    expect(() => normalizeTodos([{ content: "a", status: "deleted", priority: "low" }])).toThrow(
      /status/,
    );
    expect(() => normalizeTodos([{ content: "a", status: "pending", priority: "urgent" }])).toThrow(
      /priority/,
    );
    expect(() => normalizeTodos([todo({ status: "deleted" as never })])).toThrow(
      new RegExp(TODO_STATUSES.join(", ")),
    );
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
        "- [>] doing `medium`",
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

    const first = [todo({ content: "one", status: "in_progress", priority: "high" })];
    const result1 = await tool.execute("id-1", { todos: first }, undefined, undefined, undefined);
    expect(result1.content[0].text).toBe(JSON.stringify(first, null, 2));
    expect(result1.details.todos).toEqual(first);
    expect(result1.details.pendant.expanded).toBe(true);
    expect(result1.details.pendant.markdown).toBe(
      ["## Tasks", "", "**1 open · 1 total**", "", "- [>] one `high`"].join("\n"),
    );

    // 第二次调用整体替换，不再包含第一条
    const second = [todo({ content: "two", status: "completed", priority: "low" })];
    const result2 = await tool.execute("id-2", { todos: second }, undefined, undefined, undefined);
    expect(result2.details.todos).toEqual(second);
    expect(result2.content[0].text).toBe(JSON.stringify(second, null, 2));
    expect(result2.details.pendant.markdown).toContain("- [x] two `low`");
  });

  it("renders an empty pendant for an empty list", async () => {
    const { tool } = loadTool();
    const result = await tool.execute("id", { todos: [] }, undefined, undefined, undefined);
    expect(result.content[0].text).toBe("[]");
    expect(result.details.todos).toEqual([]);
    expect(result.details.pendant.markdown).toContain("_No todos_");
  });

  it("throws synchronously on invalid input (runtime wrapper turns it into isError)", () => {
    const { tool } = loadTool();
    expect(() =>
      tool.execute(
        "id",
        { todos: [{ content: "x", status: "deleted", priority: "low" } as never] },
        undefined,
        undefined,
        undefined,
      ),
    ).toThrow(/status/);
  });
});
