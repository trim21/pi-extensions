import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
const OTHER_OPTION = "Other";
const DONE_OPTION = "Done";

type TodoStatus = (typeof TODO_STATUSES)[number];

export interface ClaudeCodeTodo {
  content: string;
  status: TodoStatus;
  activeForm: string;
}

interface QuestionOption {
  label: string;
  description: string;
}

interface QuestionInput {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

function formatTodos(todos: readonly ClaudeCodeTodo[]): string[] | undefined {
  if (todos.length === 0) return undefined;
  const markers: Record<TodoStatus, string> = {
    pending: " ",
    in_progress: ">",
    completed: "x",
  };
  return todos.map((todo) => {
    const text = todo.status === "in_progress" ? todo.activeForm : todo.content;
    return `- [${markers[todo.status]}] ${text}`;
  });
}

async function askSingle(
  question: QuestionInput,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const title = `${question.header}: ${question.question}`;
  const selected = await ctx.ui.select(
    title,
    [...question.options.map((option) => option.label), OTHER_OPTION],
    { signal },
  );
  if (selected === undefined) return "Unanswered";
  if (selected !== OTHER_OPTION) return selected;
  const answer = await ctx.ui.input(title, "Type your answer", { signal });
  return answer?.trim() || "Unanswered";
}

async function askMultiple(
  question: QuestionInput,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<string> {
  const title = `${question.header}: ${question.question}`;
  const remaining = new Set(question.options.map((option) => option.label));
  const selected: string[] = [];
  while (remaining.size > 0) {
    const choice = await ctx.ui.select(title, [...remaining, OTHER_OPTION, DONE_OPTION], {
      signal,
    });
    if (choice === undefined || choice === DONE_OPTION) break;
    if (choice === OTHER_OPTION) {
      const answer = await ctx.ui.input(title, "Type your answer", { signal });
      if (answer?.trim()) selected.push(answer.trim());
      break;
    }
    if (remaining.delete(choice)) selected.push(choice);
  }
  return selected.length > 0 ? selected.join(", ") : "Unanswered";
}

export function registerSessionTools(pi: ExtensionAPI): void {
  const todoSchema = Type.Object(
    {
      todos: Type.Array(
        Type.Object(
          {
            content: Type.String({ minLength: 1 }),
            status: StringEnum(TODO_STATUSES),
            activeForm: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        { description: "The updated todo list" },
      ),
    },
    { additionalProperties: false },
  );

  pi.registerTool({
    name: "TodoWrite",
    label: "Todo Write",
    description: [
      "Use this tool to create and manage a structured task list for the current coding session.",
      "Pass the complete updated todo list on every call.",
      "Keep exactly one task in_progress while work remains and mark tasks completed immediately after finishing them.",
      "Each task needs an imperative content form and a present-continuous activeForm.",
    ].join("\n"),
    parameters: todoSchema,
    execute(_id, params, _signal, _onUpdate, ctx) {
      const todos = params.todos.map((todo) => ({
        content: todo.content.trim(),
        status: todo.status,
        activeForm: todo.activeForm.trim(),
      }));
      if (todos.some((todo) => todo.content === "" || todo.activeForm === "")) {
        throw new Error("Todo content and activeForm must not be blank.");
      }
      const inProgress = todos.filter((todo) => todo.status === "in_progress");
      if (inProgress.length > 1) throw new Error("Only one todo may be in_progress at a time.");
      ctx.ui.setWidget("claude-code-todos", formatTodos(todos));
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.",
          },
        ],
        details: { todos },
      });
    },
  });

  const optionSchema = Type.Object(
    {
      label: Type.String({ description: "Concise display text for the option" }),
      description: Type.String({ description: "Explanation of the option" }),
    },
    { additionalProperties: false },
  );
  const questionSchema = Type.Object(
    {
      question: Type.String({ description: "The complete question to ask" }),
      header: Type.String({ description: "Very short label displayed with the question" }),
      options: Type.Array(optionSchema, {
        minItems: 2,
        maxItems: 4,
        description: "The available choices; do not include an Other option",
      }),
      multiSelect: Type.Boolean({
        default: false,
        description: "Allow the user to select multiple options",
      }),
    },
    { additionalProperties: false },
  );

  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask User Question",
    description: [
      "Ask the user questions during execution to gather preferences, clarify requirements, or choose an implementation direction.",
      "Users can always provide their own answer through the automatically supplied Other option.",
      "Use multiSelect for questions where multiple choices may apply.",
      'If you recommend an option, put it first and append "(Recommended)" to its label.',
    ].join("\n"),
    parameters: Type.Object(
      {
        questions: Type.Array(questionSchema, {
          minItems: 1,
          maxItems: 4,
          description: "Questions to ask the user",
        }),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("Cannot ask questions: interactive UI is not available");
      const answers: Record<string, string> = {};
      for (const question of params.questions) {
        if (signal?.aborted) throw new Error("Operation aborted");
        answers[question.question] = question.multiSelect
          ? await askMultiple(question, ctx, signal)
          : await askSingle(question, ctx, signal);
      }
      const formatted = Object.entries(answers)
        .map(([question, answer]) => `"${question}"="${answer}"`)
        .join(", ");
      return {
        content: [
          {
            type: "text",
            text: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
          },
        ],
        details: { questions: params.questions, answers },
      };
    },
  });
}
