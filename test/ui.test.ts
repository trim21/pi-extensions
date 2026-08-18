/**
 * Tests for the shared select-with-optional-input and multi-select helpers.
 */
import { describe, expect, it, vi } from "vitest";

import {
  type SelectAction,
  selectCheckboxActions,
  selectMultiple,
  selectWithOptionalInput,
} from "../src/lib/ui.js";

function uiWith(select: ReturnType<typeof vi.fn>, input: ReturnType<typeof vi.fn> = vi.fn()) {
  return { select, input } as never;
}

describe("selectWithOptionalInput", () => {
  const actions: SelectAction[] = [
    { label: "A" },
    { label: "B" },
    { label: "Other", inputPrompt: "Type your answer" },
  ];

  it("shows the action labels as the selection list", async () => {
    const select = vi.fn(async () => "A");
    await selectWithOptionalInput("Pick", actions, uiWith(select));
    expect(select).toHaveBeenCalledWith("Pick", ["A", "B", "Other"], { signal: undefined });
  });

  it("returns the picked label for plain actions", async () => {
    const select = vi.fn(async () => "B");
    await expect(selectWithOptionalInput("Pick", actions, uiWith(select))).resolves.toEqual({
      label: "B",
      prompted: false,
    });
  });

  it("prompts for input when the picked action has an inputPrompt", async () => {
    const select = vi.fn(async () => "Other");
    const input = vi.fn(async () => "  free text  ");
    await expect(selectWithOptionalInput("Pick", actions, uiWith(select, input))).resolves.toEqual({
      label: "Other",
      prompted: true,
      input: "free text",
    });
    expect(input).toHaveBeenCalledWith("Pick", "Type your answer", { signal: undefined });
  });

  it("reports an undefined input when the input dialog is cancelled", async () => {
    const select = vi.fn(async () => "Other");
    const input = vi.fn().mockResolvedValue(undefined);
    await expect(selectWithOptionalInput("Pick", actions, uiWith(select, input))).resolves.toEqual({
      label: "Other",
      prompted: true,
      input: undefined,
    });
  });

  it("reports an empty string for a submitted blank input", async () => {
    const select = vi.fn(async () => "Other");
    const input = vi.fn(async () => " ".repeat(3));
    await expect(selectWithOptionalInput("Pick", actions, uiWith(select, input))).resolves.toEqual({
      label: "Other",
      prompted: true,
      input: "",
    });
  });

  it("returns undefined when the selection list is dismissed", async () => {
    const select = vi.fn().mockResolvedValue(undefined);
    await expect(selectWithOptionalInput("Pick", actions, uiWith(select))).resolves.toBeUndefined();
  });
});

describe("selectMultiple", () => {
  const entries: SelectAction[] = [
    { label: "A" },
    { label: "B" },
    { label: "Other", inputPrompt: "Type your answer" },
  ];
  const doneLabel = "Submit";

  it("shows all entries every round with ☑ marking the selected ones", async () => {
    const calls: string[][] = [];
    const select = vi.fn(async (_t: string, options: string[]) => {
      calls.push(options);
      // 依次勾选 A、B，然后提交
      if (calls.length === 1) return "☐ A";
      if (calls.length === 2) return "☐ B";
      return doneLabel;
    });
    await expect(selectMultiple("Pick", entries, uiWith(select), { doneLabel })).resolves.toEqual([
      "A",
      "B",
    ]);
    expect(calls).toEqual([
      ["☐ A", "☐ B", "☐ Other", doneLabel],
      ["☑ A", "☐ B", "☐ Other", doneLabel],
      ["☑ A", "☑ B", "☐ Other", doneLabel],
    ]);
  });

  it("unselects an entry by re-selecting its ☑ row", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("☐ A")
      .mockResolvedValueOnce("☑ A")
      .mockResolvedValueOnce(doneLabel);
    await expect(selectMultiple("Pick", entries, uiWith(select), { doneLabel })).resolves.toEqual(
      [],
    );
  });

  it("adds a custom answer via inputPrompt and lets the user unselect it", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("☐ Other")
      .mockResolvedValueOnce("☑ TiDB")
      .mockResolvedValueOnce(doneLabel);
    const input = vi.fn(async () => "TiDB");
    await expect(
      selectMultiple("Pick", entries, uiWith(select, input), { doneLabel }),
    ).resolves.toEqual([]);
    expect(input).toHaveBeenCalledWith("Pick", "Type your answer", { signal: undefined });
  });

  it.each([
    ["cancelled", undefined],
    ["blank", ""],
    ["whitespace-only", " ".repeat(3)],
  ] as const)("treats a %s input like a cancel and keeps looping", async (_label, inputValue) => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("☐ Other")
      .mockResolvedValueOnce("☐ A")
      .mockResolvedValueOnce(doneLabel);
    const input = vi.fn(async () => inputValue);
    await expect(
      selectMultiple("Pick", entries, uiWith(select, input), { doneLabel }),
    ).resolves.toEqual(["A"]);
  });

  it("returns the current selection when the dialog is dismissed", async () => {
    const select = vi.fn().mockResolvedValueOnce("☐ A").mockResolvedValueOnce(undefined);
    await expect(selectMultiple("Pick", entries, uiWith(select), { doneLabel })).resolves.toEqual([
      "A",
    ]);
  });

  it("preserves a label that already starts with the checkbox prefix", async () => {
    const tricky: SelectAction[] = [{ label: "☐ already" }];
    const select = vi.fn().mockResolvedValueOnce("☐ ☐ already").mockResolvedValueOnce(doneLabel);
    await expect(selectMultiple("Pick", tricky, uiWith(select), { doneLabel })).resolves.toEqual([
      "☐ already",
    ]);
  });
});

describe("selectCheckboxActions", () => {
  const entries: SelectAction[] = [{ label: "echo *" }, { label: "head *" }];
  const actions = [
    { action: "allow-once", label: "Allow once" },
    { action: "deny", label: "Deny" },
    { action: "deny-with-reason", label: "Deny with reason", inputPrompt: "Why?" },
  ] as const;

  it("lists actions first, then checkbox entries, and returns the picked action", async () => {
    const select = vi.fn(async (_t: string, options: string[]) => {
      expect(options).toEqual(["Allow once", "Deny", "Deny with reason", "☐ echo *", "☐ head *"]);
      return "Deny";
    });
    await expect(selectCheckboxActions("Pick", entries, actions, uiWith(select))).resolves.toEqual({
      selected: [],
      action: "deny",
      input: undefined,
    });
  });

  it("toggles entries and returns the checked selection with the action", async () => {
    const select = vi
      .fn()
      .mockResolvedValueOnce("☐ echo *")
      .mockResolvedValueOnce("☐ head *")
      .mockResolvedValueOnce("☑ echo *")
      .mockResolvedValueOnce("Allow once");
    await expect(selectCheckboxActions("Pick", entries, actions, uiWith(select))).resolves.toEqual({
      selected: ["head *"],
      action: "allow-once",
      input: undefined,
    });
  });

  it("returns the input for an action with inputPrompt", async () => {
    const select = vi.fn(async () => "Deny with reason");
    const input = vi.fn(async () => "too risky");
    await expect(
      selectCheckboxActions("Pick", entries, actions, uiWith(select, input)),
    ).resolves.toEqual({ selected: [], action: "deny-with-reason", input: "too risky" });
    expect(input).toHaveBeenCalledWith("Pick", "Why?", { signal: undefined });
  });

  it("returns undefined when the dialog is dismissed", async () => {
    const select = vi.fn().mockResolvedValue(undefined);
    await expect(
      selectCheckboxActions("Pick", entries, actions, uiWith(select)),
    ).resolves.toBeUndefined();
  });
});
