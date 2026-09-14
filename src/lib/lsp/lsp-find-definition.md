## LSP Find Definition

Find where a code symbol is defined and update nothing — read-only lookup via LSP.

- Locate the symbol with `file_path` + `line` (1-based) + `symbol` (the symbol's name exactly as it appears on that line). Any occurrence works — it does not have to be the definition.
- The tool computes the column itself; do not pass `character` unless asked to disambiguate.
- When several distinct symbols share the same name on that line, the tool refuses to guess: it reports an ambiguity error listing the candidate columns. Re-run with `character` (1-based) to pick one.
- Returns every definition site as `path:line:col` (1-based) with a source line snippet — imports, re-exports and overloads are resolved by the language server, unlike text search.
