### grep tool

- Fast content search tool that works with any codebase size
- Searches file contents using regular expressions
- Supports full regex syntax (eg. "log.*Error", "function\s+\w+", etc.)
- Filter files by pattern with the include parameter (eg. "_.js", "_.{ts,tsx}")
- Returns file paths and line numbers with matching lines
- Use this tool when you need to find files containing specific patterns
- If you need to count matches per file or use flags this tool does not expose, use the Bash tool with `rg` (ripgrep) directly instead of shelling out to `grep`.
