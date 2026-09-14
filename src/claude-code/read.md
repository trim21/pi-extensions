### Read tool

Reads a file from the local filesystem. You can access any file directly by using this tool.

Usage:

- The file_path parameter must be an absolute path, not a relative path
- By default, it reads the entire file; files over 256 KB or 25K tokens require offset and limit to read specific portions
- When you already know which part of the file you need, only read that part. This can be important for larger files.
- Results are returned as `<lineNumber>: <content>` lines, 1-indexed
- This tool allows you to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually.
- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.
