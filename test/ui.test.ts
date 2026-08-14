/**
 * Tests for the shared select-with-optional-input dialog helper.
 */
import { describe, expect, it, vi } from "vitest";

import { type SelectAction, selectWithOptionalInput } from "../src/lib/ui.js";

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
