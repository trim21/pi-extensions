## LSP Rename

Rename a code symbol (function, class, variable, ...) and update every reference across the workspace via LSP.

- Locate the symbol with `file_path` + `line` (1-based) + `symbol` (the symbol's name exactly as it appears on that line). Any occurrence works — it does not have to be the definition.
- The tool computes the column itself; do not pass `character` unless asked to disambiguate.
- When several distinct symbols share the same name on that line, the tool refuses to guess: it reports an ambiguity error listing the candidate columns. Re-run with `character` (1-based) to pick one.
- Requires an LSP server of kind `language` (per lsp.json) for the file; linter-only servers cannot rename.
- After the rename, affected files are reported with their edit counts and LSP diagnostics. Renamed files are marked as read — no re-Read needed before further edits.
