/**
 * todowrite —— opencode 风格的任务列表工具
 *
 * Aligned with opencode commit 999be62662 (v1.2.25-1672-g999be62662, 2026-08-12):
 *   https://github.com/anomalyco/opencode/blob/999be62662/packages/opencode/src/tool/todo.ts
 * 与 opencode 的差异：status/priority 这里用 StringEnum 做运行时校验
 * （opencode schema 层不校验）；opencode 输出 title "N todos"，这里未设置；
 * widget/pendant 渲染为本仓库增强（pi 特有）。
 *
 * 完整列表替换语义（与 opencode 的 todowrite 工具一致）：
 *   每次调用用给定的 todos 数组整体替换当前任务列表。
 *   todos 数组，每项含 content / status / priority 三个字段：
 *   status:   pending | in_progress | completed | cancelled
 *   priority: high | medium | low
 *
 * 状态存在工具结果 details 里（跟随会话分支），同时把任务列表渲染成
 * pendant.markdown（与 vision-agent 相同的 pendant 约定），并用
 * ctx.ui.setWidget 在编辑器上方渲染 widget（沿用原 todo-pendant.ts 的
 * widget 输出方式，只是任务内容多了 priority）。
 *
 * 与 pi 内置 todo 工具（create/update/list/... 动作）不同，本工具没有
 * 单条增删改动作 —— 模型每次都要传完整的 todo 列表，语义与 opencode 对齐。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { type ToolPendant } from "../lib/pendant.js";

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
  pendant?: ToolPendant;
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

/** trim content 并返回干净副本；字段类型已由 typebox schema 推断，无需运行时校验 */
export function normalizeTodos(todos: readonly TodoInfo[]): TodoInfo[] {
  return todos.map((t) => ({ ...t, content: t.content.trim() }));
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

/** 单条任务的渲染行，pendant markdown 与 widget 共用 */
function formatTodoLine(t: TodoInfo): string {
  return `- [${STATUS_MARK[t.status]}] ${t.content} \`${t.priority}\``;
}

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
  lines.push("", ...todos.map((t) => formatTodoLine(t)));
  return lines.join("\n");
}

/**
 * widget 渲染用的任务行（沿用原 todo-pendant.ts 的 setWidget 语义）：
 * 过滤 cancelled（对应旧版 deleted），全部被过滤时返回 undefined 以清除 widget。
 */
export function buildTodoWidgetLines(todos: readonly TodoInfo[]): string[] | undefined {
  const visible = todos;
  if (visible.length === 0) return undefined;
  return visible.map((t) => formatTodoLine(t));
}

// ── extension ────────────────────────────────────────────────────────────────

export default function todowrite(pi: ExtensionAPI) {
  pi.registerTool<typeof todowriteSchema, TodoDetails>({
    name: TOOL_NAME,
    label: "Todo Write",
    description: TODOWRITE_DESCRIPTION,
    parameters: todowriteSchema,

    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // 整体替换（opencode 语义）。
      // widget 渲染沿用原 todo-pendant 的 setWidget 方式：过滤 cancelled，
      // 全部被过滤（含空列表）时清除 widget。
      const todos = normalizeTodos(params.todos);
      ctx.ui.setWidget(TOOL_NAME, buildTodoWidgetLines(todos));
      return Promise.resolve({
        content: [{ type: "text", text: serializeTodos(todos) }],
        details: {
          todos,
          pendant: {
            markdown: buildTodoMarkdown(todos),
            expanded: false,
          },
        },
      });
    },

    renderResult(result) {
      // 用 buildTodoMarkdown 生成任务列表 markdown 原文显示（plain，不渲染富文本）
      const markdown = buildTodoMarkdown(result.details.todos);
      return {
        render: (width: number) => truncateToVisualLines(markdown, Infinity, width).visualLines,
        invalidate: (): void => undefined,
      };
    },
  });
}
