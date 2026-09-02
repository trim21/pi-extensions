## LSP Find Reference

Find every reference to a code symbol across the workspace — read-only lookup via LSP.

- Locate the symbol with `file_path` + `line` (1-based) + `symbol` (the symbol's name exactly as it appears on that line). Any occurrence works — it does not have to be the definition.
- The tool computes the column itself; do not pass `character` unless asked to disambiguate.
- When several distinct symbols share the same name on that line, the tool refuses to guess: it reports an ambiguity error listing the candidate columns. Re-run with `character` (1-based) to pick one.
- Results are grouped by file with 1-based `line:col` and source snippets; the declaration site is included. Run it before `lsp-rename` to preview the blast radius.
