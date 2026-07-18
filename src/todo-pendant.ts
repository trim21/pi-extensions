/**
 * Todo Pendant Extension
 *
 * Intercepts `@juicesharp/rpiv-todo` tool results and renders the task list
 * as a markdown pendant in Pendant's UI. Compatible with rpiv-todo's
 * four-status task model (pending / in_progress / completed / deleted).
 *
 * Usage:
 *   pi -e src/todo-pendant.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types matching @juicesharp/rpiv-todo's TaskDetails (tool/types.ts)
// ---------------------------------------------------------------------------

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

interface TaskDetails {
  action: string;
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_MARK = { pending: " ", in_progress: " ", completed: "x", deleted: " " } as const;

function formatTaskLine(t: Task): string {
  const mark = STATUS_MARK[t.status];
  const form = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
  let line = `- [${mark}] #${t.id} ${t.subject}${form}`;
  if (t.blockedBy?.length) {
    line += ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(", ")}`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "todo") return;

    const details = event.details as TaskDetails | undefined;
    if (!details?.tasks?.length) {
      ctx.ui.setWidget("todo-pendant", undefined);
      return;
    }

    const visible = details.tasks.filter((t) => t.status !== "deleted");
    if (visible.length === 0) {
      ctx.ui.setWidget("todo-pendant", undefined);
      return;
    }

    const completedCount = visible.filter((t) => t.status === "completed").length;
    const allDone = completedCount === visible.length;

    // Hide widget when all tasks are completed.
    if (allDone) {
      ctx.ui.setWidget("todo-pendant", undefined);
    } else {
      ctx.ui.setWidget("todo-pendant", [`Todos: ${completedCount}/${visible.length}`]);
    }

    const lines = visible.map(formatTaskLine);
    const header = `**Todos** (${completedCount}/${visible.length})`;
    const markdown = [header, "", ...lines].join("\n");

    return {
      details: {
        ...(event.details as Record<string, unknown>),
        pendant: { markdown, expanded: true },
      },
    };
  });
}
