### Bash tool

Executes a given bash command synchronously and returns its output.

Commands run in a sandbox: no write access outside the workspace and no network access. Use the `dangerouslyDisableSandbox` parameter to request unsandboxed execution; the user must approve this request.

Long command output is automatically truncated and the full output is saved to a file. Avoid piping commands through `tail` to limit output unless you have a specific reason.
