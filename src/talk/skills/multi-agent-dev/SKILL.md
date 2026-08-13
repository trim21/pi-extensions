---
name: multi-agent-dev
description: Coordinate multi-agent development across pi agents using the talk extension. Explains how agents discover and address each other, when to use talk-send vs talk-ask, and how to split work, exchange information, and review between agents. Use whenever you need to collaborate with other agents on the same machine.
---

# Multi-Agent Development with Talk

## Concept

Multi-agent development runs several independent pi agents in parallel and coordinates them over **talk**. Every agent is a complete workspace — its own cwd, conversation history, and context. Talk lets agents discover each other, exchange messages, ask questions, and sync progress.

The core rule: **a peer only knows what you tell it.** Messages must be self-contained — background, goal, and constraints — because the receiving agent has none of your context.

## Agent model

### Discovery and addressing

- `talk-list-agents` returns agents as JSON — **your own agent is included and marked `self: true`** (also where you learn your own id):

  ```json
  [
    {
      "status": "idle",
      "work_dir": "/path/to/cwd",
      "id": "0193a2f5-...",
      "name": "...",
      "self": true
    }
  ]
  ```

- Addressing is **by agent id only**: `talk-send` / `talk-ask` take the full `id` (pi agent uuid). Names, paths, and prefixes are not accepted.
- An unknown or invisible target is refused with `Unknown agent id` — always list before sending.

### Status

- `idle` / `working` (agent actively running) / `waiting-talk-message` (blocked in `talk-ask` waiting for a reply)
- `offline` (process exited or marked dead)
- `talk-list-agents` lists every visible agent — live or offline — with its current status.

### Visibility

- Visibility is fully group-driven: an agent in a group sees only its co-members; an agent in no group sees only itself. Ungrouped agents are invisible to everyone.
- Groups are managed by the user from the TUI (`/talk-group-*` commands) — you cannot create, join, or leave a group yourself.
- When the user joins a group they can tag their agent with a display name via `/talk-group-join <group> --name <alias>` (e.g. `frontend`, `backend`). That alias is what peers see as `name` in `talk-list-agents` — prefer it over the raw agent id when describing who is who.
- If an agent you need to collaborate with is missing from `talk-list-agents`, ask the user to pair the agents into the same group.

## Tools

| Tool               | Purpose                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `talk-list-agents` | List visible agents (`id` / `status` / `work_dir` / `name`); only group co-members (or only yourself when ungrouped) |
| `talk-send`        | Send a plain message to a single agent id (async — the main collaboration primitive)                                 |
| `talk-ask`         | Ask a question and block for the reply (default 30 min timeout)                                                      |
| `talk-reply`       | Reply to a received ask; `replyTo` is the ask id shown in the delivered message                                      |

Pairing into groups is a user action (`/talk-group-*` in the TUI); you only observe its effect through `talk-list-agents`.

## Collaboration workflows

### Split work between agents

1. `talk-list-agents` first: see which co-members exist, their `work_dir`, and status. If only yourself shows up, the peer agents are not in your group yet — ask the user to pair them.
2. Assign work by module/files with `talk-send` — state the scope, boundaries, and expected output.
3. Each agent completes its slice, then sends the result or a review request.
4. Sync progress periodically to avoid overlapping edits.

### Synchronous question/answer (need the answer to continue)

- Use `talk-ask` when the next step depends on the peer's information and the peer is reachable.
- On receiving an ask, reply with `talk-reply` using the `replyTo` id from the delivered message.
- If two agents ask each other simultaneously: the later asker yields — answer the peer's ask first, then re-ask.

### Async notifications

- Use `talk-send` for heads-ups that do not block: send and keep working.
- Messages deliver on the next natural turn by default (`queue`); `steer` interrupts the peer immediately — behavior depends on the `talk.deliver` setting.

### Cross-agent review

- Ask another agent to review your changes: `talk-send` the file paths plus a diff summary, request a review, and let it reply.
- Send paths and summaries, not whole file contents — the peer can `read` them itself.

## Message style

- Plain text, ≤32KB. Send a summary and paths, never the full file or large code blocks.
- Self-contained: background, goal, constraints — the peer has none of your context.
- Make the ask explicit: "please review", "please implement", or "FYI only".
- One topic per message so the reply stays focused.
- No empty pleasantries: skip "received, thanks for the sync" / "nice collaborating with you" / "thanks, noted". An acknowledgment with no new information wastes a peer's turn — send facts, questions, or decisions, not ceremony.

## Pitfalls

- **Avoid message loops**: if the peer sent you something or is asking you, answer it before sending new ones. Two agents pinging each other deadlock.
- **Address from known ids**: only run `talk-list-agents` to discover agents or verify an id. If you already hold a valid id (e.g. from an incoming message or a previous listing), send directly — an unknown or invisible id is refused with `Unknown agent id`.
- **Respect status**: asking an offline agent blocks until the 30 min timeout. Prefer `talk-send` there — the message queues on disk and the peer receives it when it resumes.
- **Visibility boundary**: you can only collaborate with agents that share your group; ungrouped agents and other groups' members are unreachable by design. Ask the user to pair agents before collaborating.
