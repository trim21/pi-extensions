/**
 * Shared interactive UI helpers used by multiple extensions.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SelectAction {
  label: string;
  /**
   * Set to turn this entry into a free-text input: picking it opens an input
   * dialog instead of returning immediately. The typed text (trimmed) is
   * reported via `SelectActionResult.input`; `undefined` means the input
   * dialog was cancelled, `""` that an empty value was submitted.
   */
  inputPrompt?: string;
}

export interface SelectActionResult {
  label: string;
  /** Whether the picked action carries an inputPrompt (false for plain actions) */
  prompted: boolean;
  /** Meaningful when prompted: undefined=cancelled input, ""=blank submission, otherwise the trimmed text */
  input?: string;
}

/**
 * Combined select + optional input dialog.
 *
 * Shows a selection list built from `actions`. If the user picks an action
 * with `inputPrompt`, an input dialog opens for free-text entry. Returns
 * `undefined` when the selection list is dismissed.
 */
export async function selectWithOptionalInput(
  title: string,
  actions: readonly SelectAction[],
  ui: ExtensionContext["ui"],
  opts: { signal?: AbortSignal } = {},
): Promise<SelectActionResult | undefined> {
  const { signal } = opts;
  const choice = await ui.select(
    title,
    actions.map((action) => action.label),
    { signal },
  );
  if (choice === undefined) return undefined;
  const action = actions.find((candidate) => candidate.label === choice);
  if (action?.inputPrompt === undefined) return { label: choice, prompted: false };
  const answer = await ui.input(title, action.inputPrompt, { signal });
  return {
    label: choice,
    prompted: true,
    input: answer === undefined ? undefined : answer.trim(),
  };
}
