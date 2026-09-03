### Bash tool

Executes a given bash command and returns its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

Commands run in a sandbox: no write access outside the workspace and no network access. Use the `dangerouslyDisableSandbox` parameter to request unsandboxed execution; the user must approve this request.

Long command output is automatically truncated and the full output is saved to a file. Avoid piping commands through `tail` to limit output unless you have a specific reason.

IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

- File search: Use Glob (NOT find or ls)
- Content search: Use Grep (NOT grep or rg)
- Read files: Use Read (NOT cat/head/tail)
- Edit files: Use Edit (NOT sed/awk)
- Write files: Use Write (NOT echo >/cat <<EOF)
- Communication: Output text directly (NOT echo/printf)
  While the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

- You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).
- Prever to use workdir argument over `cd ...`
- When issuing multiple commands:
- If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel.
- If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.
- Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
- DO NOT use newlines to separate commands (newlines are ok in quoted strings).
- For git commands:
- Prefer to create a new commit rather than amending an existing commit.
- Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
- Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
- Avoid unnecessary `sleep` commands:
- Do not sleep between commands that can run immediately — just run them.
- Do not retry failing commands in a sleep loop — diagnose the root cause.

**do not use `2>&1 | tee test.log`** to reduce command outout, long command are reduced and save to file for future use auto automatically, you will get a file after the command with long output.
