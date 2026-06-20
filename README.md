# pi-extensions

Custom coding-agent extensions for [pi](https://github.com/earendil-works/pi-mono).

## Extensions

### bwrap — OS-level sandbox for bash commands

Wraps all bash commands in [bubblewrap](https://github.com/containers/bubblewrap) for filesystem and network isolation.

**Prerequisites:** install bubblewrap (`apt install bubblewrap`, `pacman -S bubblewrap`, `dnf install bubblewrap`).

**Modes** (switchable at runtime with `/bwrap-mode`):

| Mode              | Sandbox | Network | Writable fs        | Escalation    |
| ----------------- | :-----: | :-----: | ------------------ | ------------- |
| `allow-all`       |   off   |   on    | full               | not needed    |
| `workspace-write` |   on    |   off   | workspace + `/tmp` | user approves |
| `readonly`        |   on    |   off   | none               | user approves |

**Escalation:** the bash tool is re-registered with a `dangerously_allow_full_access` parameter. Set to `true` to request unsandboxed execution. The user is prompted to approve or deny.

**Protected directories:** `.git`, `.pi`, `.agent` are always read-only inside the sandbox, even in `workspace-write` mode.

**Config** (`.pi/bwrap.json`, project takes precedence over `~/.pi/agent/extensions/bwrap.json`):

```jsonc
{
  "mode": "workspace-write", // "allow-all" | "workspace-write" | "readonly"
  "bwrapPath": "/usr/local/bin/bwrap", // optional, custom bwrap binary path
  "writablePaths": [".", "/tmp", "~/my-projects"], // ~ expanded to $HOME, overwrites default
  "extraReadablePaths": ["~/.config"], // merged with default, adds ro-bind
  "tmpfsPaths": [],
  "extraArgs": ["--die-with-parent"], // extra bwrap arguments
}
```

### workspace-guard — restrict file writes to the workspace

Blocks `write` and `edit` tools from targeting paths outside the workspace. Read tools (`read`, `ls`, `find`, `grep`) are unrestricted.

- Paths inside the workspace or `/tmp` are auto-allowed.
- Paths outside require user approval via confirmation dialog.
- No configuration needed.

## Installation

### Via npm/git package

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["github:trim21/pi-extensions"],
}
```

## Development

```bash
pnpm install
pnpm run check    # tsc --noEmit + prettier --check
pnpm run format   # prettier --write
```
