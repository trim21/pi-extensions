/**
 * Tests for the question extension (opencode-style question tool):
 * - normalizeQuestions: trim + defaults
 * - formatAnswers: opencode output format
 * - tool registration metadata
 * - execute: single / custom / skip / multiple flows via mocked ui.select/ui.input
 */
import { describe, expect, it, vi } from "vitest";

import question, {
  CUSTOM_LABEL,
  DONE_LABEL,
  formatAnswers,
  normalizeQuestions,
  type Question,
  TOOL_NAME,
} from "../src/opencode/question.js";

interface Tool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: { questions: Question[] },
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: {
      hasUI: boolean;
      ui: {
        select: (t: string, o: string[]) => Promise<string | undefined>;
        input: (t: string, p?: string) => Promise<string | undefined>;
      };
    },
  ) => Promise<{
    content: { type: string; text: string }[];
    details: { questions: Question[]; answers: string[][] };
  }>;
}

function loadTool(): { tool: Tool } {
  let tool: Tool | undefined;
  question({
    registerTool: (def: Tool) => {
      tool = def;
    },
  } as never);
  return { tool: tool! };
}

const q = (over: Partial<Question>): Question => ({
  question: "Which one?",
  header: "Pick",
  options: [
    { label: "A", description: "option A" },
    { label: "B", description: "option B" },
  ],
  multiple: false,
  ...over,
});

const SKIP: string | undefined = undefined;

function ctxWith(ui: {
  select?: (t: string, o: string[]) => Promise<string | undefined>;
  input?: (t: string, p?: string) => Promise<string | undefined>;
}) {
  return {
    hasUI: true,
    ui: {
      select:
        ui.select ??
        (async () => {
          throw new Error("select not stubbed");
        }),
      input:
        ui.input ??
        (async () => {
          throw new Error("input not stubbed");
        }),
    },
  };
}

describe("normalizeQuestions", () => {
  it("trims fields and defaults multiple to false", () => {
    const input = [
      {
        question: "  What? ",
        header: " H ",
        options: [{ label: " A ", description: " d " }],
      },
    ];
    expect(normalizeQuestions(input)).toEqual([
      {
        question: "What?",
        header: "H",
        options: [{ label: "A", description: "d" }],
        multiple: false,
      },
    ]);
  });

  it("defaults missing description", () => {
    expect(
      normalizeQuestions([
        { question: "Q", header: "H", options: [{ label: "A", description: "" }] },
      ]),
    ).toEqual([
      { question: "Q", header: "H", options: [{ label: "A", description: "" }], multiple: false },
    ]);
  });
});

describe("formatAnswers", () => {
  it("matches opencode's output format", () => {
    const questions = [q({ question: "What?" }), q({ question: "Which env?" })];
    expect(formatAnswers(questions, [["A"], []])).toBe(
      'User has answered your questions: "What?"="A", "Which env?"="Unanswered". You can now continue with the user\'s answers in mind.',
    );
  });

  it("joins multiple answers with a comma", () => {
    const questions = [q({ question: "Pick many" })];
    expect(formatAnswers(questions, [["A", "B"]])).toContain('"Pick many"="A, B"');
  });
});

describe("tool registration", () => {
  it("registers question with the opencode parameter shape", () => {
    const { tool } = loadTool();
    expect(tool.name).toBe(TOOL_NAME);
    expect(tool.label).toBe("Question");
    expect(tool.parameters).toBeDefined();
    expect(tool.description).toContain("Gather user preferences or requirements");
    expect(tool.description).toContain("Type your own answer");
    expect(tool.description).toContain("(Recommended)");
  });
});

describe("execute", () => {
  it("asks a single question and returns the selected label", async () => {
    const { tool } = loadTool();
    const select = vi.fn(async (title: string, options: string[]) => {
      expect(title).toBe("Pick: Which one?");
      expect(options).toEqual(["A", "B", CUSTOM_LABEL]);
      return "B";
    });
    const result = await tool.execute(
      "id",
      { questions: [q({})] },
      undefined,
      undefined,
      ctxWith({ select }),
    );
    expect(result.content[0].text).toContain('"Which one?"="B"');
    expect(result.details.answers).toEqual([["B"]]);
  });

  it("prompts for free text when the custom option is chosen", async () => {
    const { tool } = loadTool();
    const select = vi.fn(async () => CUSTOM_LABEL);
    const input = vi.fn(async () => " my own answer ");
    const result = await tool.execute(
      "id",
      { questions: [q({})] },
      undefined,
      undefined,
      ctxWith({ select, input }),
    );
    expect(result.details.answers).toEqual([["my own answer"]]);
    expect(input).toHaveBeenCalledWith("Pick: Which one?", "Type your answer…", {
      signal: undefined,
    });
  });

  it("treats blank free-text input as an unanswered question", async () => {
    const { tool } = loadTool();
    const select = vi.fn(async () => CUSTOM_LABEL);
    const input = vi.fn(async () => " ".repeat(3));
    const result = await tool.execute(
      "id",
      { questions: [q({})] },
      undefined,
      undefined,
      ctxWith({ select, input }),
    );
    expect(result.details.answers).toEqual([[]]);
    expect(result.content[0].text).toContain("Unanswered");
  });

  it("uses the question text as the dialog title when header is empty", async () => {
    const { tool } = loadTool();
    const select = vi.fn(async (title: string) => {
      expect(title).toBe("Which one?");
      return "A";
    });
    const result = await tool.execute(
      "id",
      { questions: [q({ header: "" })] },
      undefined,
      undefined,
      ctxWith({ select }),
    );
    expect(result.details.answers).toEqual([["A"]]);
  });

  it("treats a skipped question as Unanswered and continues", async () => {
    const { tool } = loadTool();
    const select = vi.fn(async () => SKIP);
    const result = await tool.execute(
      "id",
      { questions: [q({})] },
      undefined,
      undefined,
      ctxWith({ select }),
    );
    expect(result.details.answers).toEqual([[]]);
    expect(result.content[0].text).toContain("Unanswered");
  });

  it("accumulates multiple selections until Done", async () => {
    const { tool } = loadTool();
    const multi = q({
      multiple: true,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
        { label: "C", description: "c" },
      ],
    });
    const calls: string[][] = [];
    const select = vi.fn(async (_t: string, options: string[]) => {
      calls.push(options);
      // 依次选 A、C，然后 Done（此时 B 仍可选，但用户结束勾选）
      if (calls.length === 1) return "☐: A";
      if (calls.length === 2) return "☐: C";
      return DONE_LABEL;
    });
    const result = await tool.execute(
      "id",
      { questions: [multi] },
      undefined,
      undefined,
      ctxWith({ select }),
    );
    expect(result.details.answers).toEqual([["A", "C"]]);
    expect(calls).toEqual([
      ["☐: A", "☐: B", "☐: C", DONE_LABEL],
      ["☑: A", "☐: B", "☐: C", DONE_LABEL],
      ["☑: A", "☐: B", "☑: C", DONE_LABEL],
    ]);
  });

  it("unselects a multi-select option by re-selecting it", async () => {
    const { tool } = loadTool();
    const multi = q({
      multiple: true,
      options: [
        { label: "A", description: "a" },
        { label: "B", description: "b" },
      ],
    });
    let calls = 0;
    const select = vi.fn(async () => {
      calls++;
      // 先选 A，再反选 A，然后 Done
      if (calls === 1) return "☐: A";
      if (calls === 2) return "☑: A";
      return DONE_LABEL;
    });
    const result = await tool.execute(
      "id",
      { questions: [multi] },
      undefined,
      undefined,
      ctxWith({ select }),
    );
    expect(result.details.answers).toEqual([[]]);
  });

  it("throws when no interactive UI is available", async () => {
    const { tool } = loadTool();
    await expect(
      tool.execute("id", { questions: [q({})] }, undefined, undefined, {
        hasUI: false,
        ui: ctxWith({}).ui,
      }),
    ).rejects.toThrow(/interactive UI/);
  });
});
