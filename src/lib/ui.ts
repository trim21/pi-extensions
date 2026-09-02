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

/** 已选 / 未选 的符号标记：打勾方框 / 空方框 */
const CHECKED_PREFIX = "☑ ";
const UNCHECKED_PREFIX = "☐ ";

/**
 * Toggle-style multi-select loop built on `ui.select`.
 *
 * Every round lists ALL `entries` — already-selected ones render with a
 * `☑ ` marker, the rest with `☐ ` — so re-selecting an entry unchecks it.
 * Picking an entry with `inputPrompt` opens an input dialog; the typed text
 * joins the selection as a `☑ ` row in later rounds and can be unselected
 * like any other entry. Picking `doneLabel` (or dismissing the dialog) ends
 * the loop and returns the selected labels in selection order. Display text
 * is mapped back to the original label via an explicit table so a `☐ ` /
 * `☑ ` prefix inside a label is unambiguous.
 */
export async function selectMultiple(
  title: string,
  entries: readonly SelectAction[],
  ui: ExtensionContext["ui"],
  opts: { signal?: AbortSignal; doneLabel: string },
): Promise<string[]> {
  const selected: string[] = [];
  for (;;) {
    const selectedSet = new Set(selected);
    const displayToLabel = new Map<string, string>();
    const round: SelectAction[] = [];
    for (const entry of entries) {
      const display = `${selectedSet.has(entry.label) ? CHECKED_PREFIX : UNCHECKED_PREFIX}${entry.label}`;
      displayToLabel.set(display, entry.label);
      round.push({ ...entry, label: display });
    }
    // 经 inputPrompt 输入的自定义答案不是固定条目：单独列出，同样可反选
    for (const label of selected) {
      if (entries.some((entry) => entry.label === label)) continue;
      const display = `${CHECKED_PREFIX}${label}`;
      displayToLabel.set(display, label);
      round.push({ label: display });
    }
    const result = await selectWithOptionalInput(
      title,
      [...round, { label: opts.doneLabel }],
      ui,
      opts,
    );
    if (result === undefined || result.label === opts.doneLabel) break;
    if (result.prompted) {
      // 自定义答案进入已选并继续循环：可反选或继续勾选，最终手动提交
      if (result.input && !selectedSet.has(result.input)) selected.push(result.input);
      continue;
    }
    const label = displayToLabel.get(result.label);
    if (label === undefined) continue;
    if (selectedSet.has(label)) selected.splice(selected.indexOf(label), 1);
    else selected.push(label);
  }
  return selected;
}

/** 结束动作：选中即结束多选循环；带 inputPrompt 时先弹输入框，内容经 input 返回。 */
export interface CheckboxAction<T extends string> {
  action: T;
  label: string;
  inputPrompt?: string;
}

export interface CheckboxActionResult<T extends string> {
  /** 勾选的条目 label（勾选顺序，经 inputPrompt 输入的条目已并入）。 */
  selected: string[];
  /** 用户选中的结束动作。 */
  action: T;
  /** 结束动作带 inputPrompt 时的输入内容：undefined=取消输入，""=空提交。 */
  input?: string;
}

/**
 * Checkbox 多选 + 结束动作的组合对话框（selectMultiple 的带操作变体）。
 *
 * 循环列出全部 `actions`（固定操作，选中即结束循环）与全部 `entries`
 * （☑/☐ 前缀切换勾选）；对话框关闭（dismiss）返回 undefined。操作在前、
 * checkbox 条目在后，用户先决定本次动作，需要时再勾选要持久化的规则。
 */
export async function selectCheckboxActions<T extends string>(
  title: string,
  entries: readonly SelectAction[],
  actions: readonly CheckboxAction<T>[],
  ui: ExtensionContext["ui"],
  opts: { signal?: AbortSignal } = {},
): Promise<CheckboxActionResult<T> | undefined> {
  const selected: string[] = [];
  for (;;) {
    const selectedSet = new Set(selected);
    const displayToLabel = new Map<string, string>();
    const round: SelectAction[] = [];
    for (const entry of entries) {
      const display = `${selectedSet.has(entry.label) ? CHECKED_PREFIX : UNCHECKED_PREFIX}${entry.label}`;
      displayToLabel.set(display, entry.label);
      round.push({ ...entry, label: display });
    }
    const result = await selectWithOptionalInput(title, [...actions, ...round], ui, opts);
    if (result === undefined) return undefined;
    const action = actions.find((candidate) => candidate.label === result.label);
    if (action !== undefined) return { selected, action: action.action, input: result.input };
    const label = displayToLabel.get(result.label);
    if (label === undefined) continue;
    if (selectedSet.has(label)) selected.splice(selected.indexOf(label), 1);
    else selected.push(label);
  }
}
