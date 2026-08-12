/**
 * todowrite —— opencode 风格的任务列表工具
 *
 * 完整列表替换语义（与 opencode 的 todowrite 工具一致）：
 *   每次调用用给定的 todos 数组整体替换当前任务列表。
 *   todos 数组，每项含 content / status / priority 三个字段：
 *   status:   pending | in_progress | completed | cancelled
 *   priority: high | medium | low
 *
 * 状态存在工具结果 details 里（跟随会话分支），同时把任务列表渲染成
 * pendant.markdown（与 vision-agent 相同的 pendant 约定），每次调用都用
 * 完整的 markdown 列表输出对应的任务 —— 取代原 todo-pendant.ts 里
 * setWidget 的 widget 输出方式。
 *
 * 与 pi 内置 todo 工具（create/update/list/... 动作）不同，本工具没有
 * 单条增删改动作 —— 模型每次都要传完整的 todo 列表，语义与 opencode 对齐。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── constants ────────────────────────────────────────────────────────────────

export const TOOL_NAME = "todowrite";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export const TODO_PRIORITIES = ["high", "medium", "low"] as const;

export type TodoStatus = (typeof TODO_STATUSES)[number];
export type TodoPriority = (typeof TODO_PRIORITIES)[number];

/** opencode 的 todowrite 描述（语义等价），补上「整体替换」这一关键规则 */
export const TODOWRITE_DESCRIPTION = [
  "Create and maintain a structured task list for the current coding session. Tracks progress, organizes multi-step work, and surfaces status to the user.",
  "",
  "This tool REPLACES the entire todo list: pass the full updated list of todos on every call.",
  "",
  "## When to use",
  "Use proactively when:",
  "- The task requires 3+ distinct steps or actions (not just 3 tool calls for a single conceptual step)",
  "- The work is non-trivial and benefits from planning",
  "- The user provides multiple tasks (numbered or comma-separated) or explicitly asks for a todo list",
  "- New instructions arrive - capture them as todos",
  "- You start a task - mark it `in_progress` (only one at a time) before working",
  "- You finish a task - mark it `completed` and add any follow-ups discovered during the work",
  "",
  "## When NOT to use",
  "Skip when:",
  "- The work is a single, straightforward task (or <3 trivial steps)",
  "- The request is purely informational or conversational",
  "- Tracking adds no organizational value",
  "",
  "## States",
  "- `pending` - not started",
  "- `in_progress` - actively working (exactly ONE at a time)",
  "- `completed` - finished successfully",
  "- `cancelled` - no longer needed",
  "",
  "## Rules",
  "- Update status in real time; don't batch completions",
  "- Mark `completed` only after the required work is actually done, including any required verification. Never based on intent.",
  "- Keep exactly one `in_progress` while work remains",
  "- If blocked or partial, keep it `in_progress` and add a follow-up todo describing the blocker",
  "- Preserve user-provided commands verbatim (flags, args, order)",
  "- Items should be specific and actionable; break large work into smaller steps",
].join("\n");

// ── types ────────────────────────────────────────────────────────────────────

export interface TodoInfo {
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

export interface TodoDetails {
  todos: TodoInfo[];
  pendant: { markdown: string; expanded: boolean };
}

// ── schema（与 opencode 的 Parameters 一致）──────────────────────────────────

const todoInfoSchema = Type.Object({
  content: Type.String({ description: "Brief description of the task" }),
  status: StringEnum(TODO_STATUSES, {
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: StringEnum(TODO_PRIORITIES, {
    description: "Priority level of the task: high, medium, low",
  }),
});

export const todowriteSchema = Type.Object({
  todos: Type.Array(todoInfoSchema, { description: "The updated todo list" }),
});

// ── 纯函数（可测试）──────────────────────────────────────────────────────────

export function isTodoStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (TODO_STATUSES as readonly string[]).includes(value);
}

export function isTodoPriority(value: unknown): value is TodoPriority {
  return typeof value === "string" && (TODO_PRIORITIES as readonly string[]).includes(value);
}

/**
 * 把 execute 拿到的原始 todos 规整成干净、类型安全的列表。
 * 校验失败直接抛错（execute 抛出错误会置 isError 并向模型报告），
 * 不会静默吞掉非法状态。
 */
export function normalizeTodos(raw: unknown): TodoInfo[] {
  if (!Array.isArray(raw)) throw new Error("todos must be an array");
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`todos[${index}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    const content = typeof obj.content === "string" ? obj.content.trim() : "";
    if (!content) throw new Error(`todos[${index}].content is required`);
    if (!isTodoStatus(obj.status)) {
      throw new Error(
        `todos[${index}].status must be one of ${TODO_STATUSES.join(", ")}, got ${JSON.stringify(obj.status)}`,
      );
    }
    if (!isTodoPriority(obj.priority)) {
      throw new Error(
        `todos[${index}].priority must be one of ${TODO_PRIORITIES.join(", ")}, got ${JSON.stringify(obj.priority)}`,
      );
    }
    return { content, status: obj.status, priority: obj.priority };
  });
}

/** opencode 返回标题里的计数：未完成（status !== completed）的任务数 */
export function countOpen(todos: readonly TodoInfo[]): number {
  return todos.filter((t) => t.status !== "completed").length;
}

/** 与 opencode 一致的输出：格式化的 JSON 字符串 */
export function serializeTodos(todos: readonly TodoInfo[]): string {
  return JSON.stringify(todos, null, 2);
}

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: ">",
  completed: "x",
  cancelled: "-",
};

/**
 * 把任务列表整理成 pendant 渲染用的 markdown。
 * 每个任务一行，与 vision-agent 的 pendant.markdown 约定一致。
 */
export function buildTodoMarkdown(todos: readonly TodoInfo[]): string {
  const lines = ["## Tasks", "", `**${countOpen(todos)} open · ${todos.length} total**`];
  if (todos.length === 0) {
    lines.push("", "_No todos_");
    return lines.join("\n");
  }
  lines.push("");
  for (const t of todos) {
    lines.push(`- [${STATUS_MARK[t.status]}] ${t.content} \`${t.priority}\``);
  }
  return lines.join("\n");
}

// ── extension ────────────────────────────────────────────────────────────────

export default function todowrite(pi: ExtensionAPI) {
  pi.registerTool<typeof todowriteSchema, TodoDetails>({
    name: TOOL_NAME,
    label: "Todo Write",
    description: TODOWRITE_DESCRIPTION,
    promptSnippet: "Track multi-step work via a todo list (full-list replacement)",
    promptGuidelines: [
      "Use todowrite to plan and track multi-step work: mark a task in_progress before starting it and completed only after the work is actually done and verified.",
      "todowrite replaces the entire todo list, so pass the full updated array of { content, status, priority } items every time.",
      "Keep exactly one task in_progress at a time; if blocked, keep it in_progress and add a follow-up todo describing the blocker.",
    ],
    parameters: todowriteSchema,

    execute(_toolCallId, params) {
      // 整体替换（opencode 语义）；normalizeTodos 保证非法输入可定位报错。
      // 纯同步逻辑，用 Promise.resolve 满足 execute 的 Promise 返回类型。
      const todos = normalizeTodos(params.todos);
      return Promise.resolve({
        content: [{ type: "text", text: serializeTodos(todos) }],
        details: {
          todos,
          pendant: {
            markdown: buildTodoMarkdown(todos),
            expanded: true,
          },
        },
      });
    },
  });
}
