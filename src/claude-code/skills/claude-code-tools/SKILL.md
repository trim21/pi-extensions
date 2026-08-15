---
name: claude-code-tools
description: Exact behavior of the Claude Code style tools (Read/Edit/Write/Grep/Glob/Bash/TodoWrite/AskUserQuestion) in the @trim21/personal-pi-extensions package: output formats, matching rules, read-before-write requirements, pagination semantics, and conventions. Load whenever you use these tools or are unsure how they behave.
---

# Claude Code Tools Behavior

This package registers two parallel tool suites: opencode style (lowercase `read`/`edit`/`write`/`bash`/`todowrite`/`question`) and Claude Code style (capitalized `Read`/`Edit`/`Write`/`Bash`/`Grep`/`Glob`/`TodoWrite`/`AskUserQuestion`). They share the bwrap sandbox and write-guard. **Only one suite should be enabled** — enabling both duplicates commands (e.g. `/bwrap` vs `/bwrap:1`) and injects the bwrap system-prompt section twice.

The capitalized tools below follow Claude Code behavior with a few deliberate deviations. Where behavior differs from stock Claude Code it is called out.

## Read

- Output is `<lineNumber>\t<content>` per line, 1-indexed, **no padding** (compact format).
- Input is normalized: UTF-8 BOM stripped, `\r\n` → `\n` (CRLF stripped), and a trailing empty line is always present — **`totalLines` is one more than the editor line count** for non-empty files.
- By default reads the **entire file**, capped at 256 KB (bytes) and a rough 25K-token estimate (4 chars/token, no tokenizer). Whole reads over either cap error with `File content (X) exceeds maximum allowed size/tokens (...) — use offset and limit`; providing `limit` bypasses the byte cap and only the selected range counts toward the token cap.
- `offset`/`limit` are 1-based positive integers. Out-of-range offset returns `Warning: the file exists but is shorter than the provided offset (N). The file has M lines.`; empty files return `Warning: the file exists but the contents are empty.`
- Missing file → `File does not exist. Note: your current working directory is <cwd>.` plus a `Did you mean ...?` suggestion (same-base different-extension, or a corrected path under cwd).

## Edit / Write

- **You must Read a file before editing or overwriting it.** The tool compares a content digest against the last read; after your own Edit/Write the recorded digest is refreshed, so consecutive edits by you are fine. An external change (user edit, linter, another process) triggers `File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.` — re-Read before writing.
- **Deviation from Claude Code:** staleness is checked by content digest, not mtime.

### Edit specifics

- Matching first tries an exact match, then a **quote-normalized match** (curly quotes in the file match straight quotes from the model); the replacement inherits the file's curly-quote style.
- Matching happens on CRLF-normalized content — `old_string` never needs `\r` — and the file's dominant line ending is restored on write.
- Empty `old_string` means create-or-fill: nonexistent file → create it; empty file → fill it; non-empty file → `Cannot create new file - file already exists.` Neither create nor fill requires a prior Read.
- `old_string === new_string` → `No changes to make: old_string and new_string are exactly the same.`
- Not found → `String to replace not found in file.\nString: <old_string>`
- Multiple matches without `replace_all` → error listing the match count and asking for more context, with `\nString: <old_string>`.
- `replace_all: true` success message: `The file X has been updated. All occurrences were successfully replaced.`
- Missing file → `File does not exist. Note: your current working directory is <cwd>.` plus a `Did you mean ...?` suggestion (same-base different-extension, or a corrected path under cwd).
- Files over 1 GiB are refused; `.ipynb` files are refused.

### Write specifics

- Creating a new file → `File created successfully at: X`; overwriting an existing file → `The file X has been updated successfully.` (the distinction is reported even though both are one tool).
- New files need no prior Read; overwriting does.

## Grep

- Modes: `files_with_matches` (default), `content`, `count`. All output paths are **relative to cwd** (absolute when outside cwd).
- `files_with_matches`: `Found N files\n<relative paths>` sorted by mtime, newest first. No matches → `No files found`.
- `content`: `path:line:content` lines. No matches → `No matches found`.
- `count`: per-file match-line counts (`-c` semantics, not match occurrences) plus `Found N total occurrences across M files.` No matches → `No matches found` + `Found 0 total occurrences across 0 files.`
- `head_limit` defaults to 250 (0 = unlimited), `offset` skips entries. When truncation or offset actually applied, a pagination note is appended (`limit: N, offset: N`), e.g. `[Showing results with pagination = limit: N, offset: N]`.
- `glob` accepts comma/space-separated patterns (brace patterns not split). `-i`, `-B/-A/-C`/`context`, `-n` (default true in content mode), `type`, `multiline` map to ripgrep flags. VCS dirs (`.git` etc.) are excluded.
- A missing `path` → `Path does not exist: ... Note: your current working directory is <cwd>.` with a corrected-path suggestion when applicable.

## Glob

- Backed by ripgrep (`--files --sort=modified`): results are **oldest first**, hidden files included, `.git` excluded, up to 100 results.
- Output paths are relative to cwd. When truncated, a final line `(Results are truncated. Consider using a more specific path or pattern.)` is appended.
- No matches → `No files found`. `path` must be an existing directory, else `Directory does not exist: ...` / `Path is not a directory: ...`.

## Bash

- Commands run through the bwrap sandbox (modes: `allow-all` / `workspace-write` / `allow-net` / `readonly`), switchable via `/bwrap-*` commands. `dangerouslyDisableSandbox: true` requests one-time unsandboxed execution. Approval flow: commands are parsed (tree-sitter, including nested `$(...)`) and matched against `approvalRules` from `bwrap.json` — an `allow` rule auto-approves, a `deny` rule rejects outright (last matching rule wins), and only unmatched commands show the approval dialog. In headless sessions unsandboxed execution is denied.
- `timeout` is in milliseconds, default 120000, max 600000. `workdir` overrides the working directory.
- **Non-zero exit code is a tool failure**: the error text starts with `Exit code N` followed by the full output (head/tail-truncated at 10000 chars if larger). **Deviation from Claude Code:** no command-semantics special cases — `grep` with no matches (exit 1), `diff` differences, `test` false, etc. all fail like any other non-zero exit.
- Output is streamed to a file under `agent-dir/tmp/<uuid>.txt` during execution; the tool result only contains the truncated tail (2000 lines / 50 KB). On truncation a note is appended: `[Showing lines X-Y of N. Full output: <path>]` — read that file for the complete output. In a read-only sandbox where the write fails, the result degrades to the in-memory tail only.
- **Deviation from Claude Code:** no auto-backgrounding on timeout — a timed-out command is killed and the error reports `Command timed out after N milliseconds`.
- The lowercase opencode-style `bash` tool differs: it **never throws** on non-zero exit — it returns the output plus a `Command exited with code N.` status text block; a timeout returns `Command exceeded timeout of N ms. Retry with a larger timeout...` instead of failing.

## TodoWrite

- Full-list replacement semantics: pass the complete updated list every call; exactly one `in_progress` allowed; statuses `pending` | `in_progress` | `completed`; each item needs `content` and `activeForm`.
- The list renders as a widget and is persisted in tool `details`; after a restart the widget is restored from the session branch. The list is **not** auto-cleared when all items are completed.

## AskUserQuestion

- Blocking: 1–4 questions, 2–4 options each; `multiSelect` for multiple selection. An `Other` free-text option is provided automatically.
- Returns `User has answered your questions: "q"="a", ... . You can now continue with the user's answers in mind.`
