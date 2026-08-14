/**
 * question —— opencode 风格的提问工具
 *
 * Aligned with opencode commit 999be62662 (v1.2.25-1672-g999be62662, 2026-08-12):
 *   https://github.com/anomalyco/opencode/blob/999be62662/packages/opencode/src/tool/question.ts
 * 与 opencode 的差异：opencode 输出 title "Asked N question(s)"，这里未设置；
 * 多选交互是平台差异（opencode 用 checkbox，这里循环 ctx.ui.select 勾选）。
 *
 * 参数与语义和 opencode 的 `question` 工具一致：
 *   questions 数组，每项含 question / header / options / multiple：
 *   - options 每项为 label / description
 *   - 单选（默认）：用户在选项里选一个，也可选「Type your own answer.」自由输入
 *   - 多选（multiple: true）：循环用 ui.select 逐个勾选，直到「✓ Done」
 *   - 每个问题返回一个 label 数组（Answer = string[]），跳过的为空数组
 *   - 输出与 opencode 一致：
 *     User has answered your questions: "q"="a", "q2"="Unanswered"...
 *
 * 交互全部走 pi 内置的 ctx.ui.select / ctx.ui.input，不写自定义 TUI 渲染。
 * 注意：ui.select 只接受 string 标签，option.description 不显示在对话框里，
 * 仅保留在 details 中（schema 仍与 opencode 对齐）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { selectWithOptionalInput } from "../lib/ui.js";

// ── constants ────────────────────────────────────────────────────────────────

export const TOOL_NAME = "question";
/** opencode 会自动追加的自定义答案选项；用户选中后走 ctx.ui.input */
export const CUSTOM_LABEL = "Type your own answer.";
/** 多选模式下结束勾选的哨兵选项 */
export const DONE_LABEL = "✓ Done";

/** 与 opencode question.txt 语义一致的描述 */
export const QUESTION_DESCRIPTION = [
  "Use this tool when you need to ask the user questions during execution. This allows you to:",
  "1. Gather user preferences or requirements",
  "2. Clarify ambiguous instructions",
  "3. Get decisions on implementation choices as you work",
  "4. Offer choices to the user about what direction to take.",
  "",
  "Usage notes:",
  '- A "Type your own answer" option is added automatically; don\'t include "Other" or catch-all options',
  "- Answers are returned as arrays of labels; set multiple to true to allow selecting more than one",
  '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
].join("\n");

// ── types ────────────────────────────────────────────────────────────────────

export interface QuestionOption {
  label: string;
  description: string;
}

/** 与 schema 对齐的输入形状（multiple 可选） */
export interface QuestionInput {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

/** 规整后的问题（multiple 已默认化为 boolean） */
export interface Question extends Omit<QuestionInput, "multiple"> {
  multiple: boolean;
}

/** 每个问题的答案：选中的 label 数组（自定义输入就是单元素的 [text]） */
export type Answer = string[];

export interface QuestionDetails {
  questions: Question[];
  answers: Answer[];
}

// ── schema（与 opencode 的 Question.Prompt 一致）──────────────────────────────

const optionSchema = Type.Object({
  label: Type.String({ description: "Display text (concise, 1-5 words)" }),
  description: Type.String({ description: "Explanation of what this choice means" }),
});

const questionSchema = Type.Object({
  question: Type.String({ description: "The complete question to ask" }),
  header: Type.String({ description: "Very short label (max 30 chars)" }),
  options: Type.Array(optionSchema, { description: "Available choices" }),
  multiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple choices" })),
});

export const questionParamsSchema = Type.Object({
  questions: Type.Array(questionSchema, { description: "Questions to ask" }),
});

// ── 纯函数（可测试）──────────────────────────────────────────────────────────

/** trim 各字段并把可选的 multiple 默认化为 false */
export function normalizeQuestions(questions: readonly QuestionInput[]): Question[] {
  return questions.map((q) => ({
    question: q.question.trim(),
    header: q.header.trim(),
    options: q.options.map((o) => ({ label: o.label.trim(), description: o.description.trim() })),
    multiple: q.multiple === true,
  }));
}

/** 与 opencode 一致的输出：每个问题 "q"="a, b"，空答案显示 Unanswered */
export function formatAnswers(questions: readonly Question[], answers: readonly Answer[]): string {
  const formatted = questions
    .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
    .join(", ");
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`;
}

function dialogTitle(q: Question): string {
  return q.header ? `${q.header}: ${q.question}` : q.question;
}

async function askSingle(q: Question, ctx: ExtensionContext): Promise<Answer> {
  const title = dialogTitle(q);
  const result = await selectWithOptionalInput(
    title,
    [
      ...q.options.map((o) => ({ label: o.label })),
      { label: CUSTOM_LABEL, inputPrompt: "Type your answer…" },
    ],
    ctx.ui,
  );
  if (result === undefined) return [];
  return result.prompted ? (result.input ? [result.input] : []) : [result.label];
}

async function askMultiple(q: Question, ctx: ExtensionContext): Promise<Answer> {
  const title = dialogTitle(q);
  const selected: string[] = [];
  const remaining = new Set(q.options.map((o) => o.label));
  while (remaining.size > 0) {
    const choice = await ctx.ui.select(title, [...remaining, DONE_LABEL]);
    if (choice === undefined || choice === DONE_LABEL) break;
    if (!remaining.has(choice)) continue;
    selected.push(choice);
    remaining.delete(choice);
  }
  return selected;
}

// ── extension ────────────────────────────────────────────────────────────────

export default function question(pi: ExtensionAPI) {
  pi.registerTool<typeof questionParamsSchema, QuestionDetails>({
    name: TOOL_NAME,
    label: "Question",
    description: QUESTION_DESCRIPTION,
    parameters: questionParamsSchema,
    // 交互式提问不能与其他工具并行弹出，逐个串行执行
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        throw new Error("Cannot ask questions: interactive UI is not available in this mode");
      }
      const questions = normalizeQuestions(params.questions);

      const answers: Answer[] = [];
      for (const q of questions) {
        answers.push(q.multiple ? await askMultiple(q, ctx) : await askSingle(q, ctx));
      }

      return {
        content: [{ type: "text", text: formatAnswers(questions, answers) }],
        details: { questions, answers },
      };
    },
  });
}
