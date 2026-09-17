### Read tool

Reads a file from the local filesystem. You can access any file directly by using this tool.

Usage:

- The file_path parameter accepts an absolute path or a path relative to the working directory
- By default, it reads the entire file; files over 256 KB or 25K tokens require offset and limit to read specific portions
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Do not use head/tail (or sed -n) via the Bash tool to read parts of files — use offset and limit here instead. They are line-based: `offset=5, limit=10` reads 10 lines starting at line 5 (like `sed -n '5,14p'`), and a negative offset counts from the end of the file — `offset=-5` reads the last 5 lines (like `tail -n 5`). Line numbers in the output are always absolute.
- Results are returned as `<lineNumber>: <content>` lines, 1-indexed
- This tool allows you to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually.
- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
