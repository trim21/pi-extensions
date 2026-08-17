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

const CHECKED_PREFIX = "[X]: ";
const UNCHECKED_PREFIX = "[ ]: ";

/**
 * Toggle-style multi-select loop built on `ui.select`.
 *
 * Every round lists ALL `entries` — already-selected ones render with a
 * `[X]: ` checkbox marker, the rest with `[ ]: ` — so re-selecting an entry
 * unchecks it. Picking an entry with `inputPrompt` opens an input dialog and,
 * when non-empty, adds the typed text and ends the loop. Picking `doneLabel`
 * (or dismissing the dialog) ends the loop and returns the selected labels in
 * selection order. Display text is mapped back to the original label via an
 * explicit table so a `[ ]:` / `[X]:` prefix inside a label is unambiguous.
 */
export async function selectMultiple(
  title: string,
  entries: readonly SelectAction[],
  ui: ExtensionContext["ui"],
  opts: { signal?: AbortSignal; doneLabel: string },
): Promise<string[]> {
  const selected: string[] = [];
  while (true) {
    const selectedSet = new Set(selected);
    const displayToLabel = new Map<string, string>();
    const round = entries.map((entry) => {
      const display = `${selectedSet.has(entry.label) ? CHECKED_PREFIX : UNCHECKED_PREFIX}${entry.label}`;
      displayToLabel.set(display, entry.label);
      return { ...entry, label: display };
    });
    const result = await selectWithOptionalInput(
      title,
      [...round, { label: opts.doneLabel }],
      ui,
      opts,
    );
    if (result === undefined || result.label === opts.doneLabel) break;
    if (result.prompted) {
      if (result.input) selected.push(result.input);
      break;
    }
    const label = displayToLabel.get(result.label);
    if (label === undefined) continue;
    if (selectedSet.has(label)) selected.splice(selected.indexOf(label), 1);
    else selected.push(label);
  }
  return selected;
}
