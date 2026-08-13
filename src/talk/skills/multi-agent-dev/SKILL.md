---
name: multi-agent-dev
description: Coordinate multi-agent development across pi sessions using the talk extension. Explains how sessions discover and address each other, when to use talk-send vs talk-ask, and how to split work, exchange information, and review between agents. Use whenever you need to collaborate with other pi sessions or agents on the same machine.
---

# Multi-Agent Development with Talk

## Concept

Multi-agent development runs several independent pi sessions in parallel and coordinates them over **talk**. Every session is a complete agent workspace — its own cwd, conversation history, and context. Talk lets sessions discover each other, exchange messages, ask questions, and sync progress.

The core rule: **a peer only knows what you tell it.** Messages must be self-contained — background, goal, and constraints — because the receiving session has none of your context.

## Session model

### Discovery and addressing

- `talk-list-sessions` returns sessions as JSON — **your own session is included and marked `self: true`** (also where you learn your own id):

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

- Addressing is **by session id only**: `talk-send` / `talk-ask` take the full `id` (pi session uuid). Names, paths, and prefixes are not accepted.
- An unknown or invisible target is refused with `Unknown session id` — always list before sending.

### Status

- `idle` / `working` (agent actively running) / `waiting-talk-message` (blocked in `talk-ask` waiting for a reply)
- `offline` (process exited or marked dead)
- `talk-list-sessions` lists every visible session — live or offline — with its current status.

### Visibility

- Each workspace controls what it can see via `allowed` in `<cwd>/.pi/talk.json` (path prefixes). Sessions outside the prefixes are neither listed nor addressable.
- Visibility is one-way: you seeing a session does not mean it sees you.

## Tools

| Tool                 | Purpose                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `talk-list-sessions` | List visible sessions (`id` / `status` / `work_dir` / `name`)                          |
| `talk-send`          | Send a plain message to a single session id (async — the main collaboration primitive) |
| `talk-ask`           | Ask a question and block for the reply (default 30 min timeout)                        |
| `talk-reply`         | Reply to a received ask; `replyTo` is the ask id shown in the delivered message        |

In the TUI: `/talk` lists sessions, `/talk-dead` marks a session as dead (shown offline, swept soon).

## Collaboration workflows

### Split work between sessions

1. `talk-list-sessions` first: see which sessions exist, their `work_dir`, and status.
2. Assign work by module/files with `talk-send` — state the scope, boundaries, and expected output.
3. Each session completes its slice, then sends the result or a review request.
4. Sync progress periodically to avoid overlapping edits.

### Synchronous question/answer (need the answer to continue)

- Use `talk-ask` when the next step depends on the peer's information and the peer is reachable.
- On receiving an ask, reply with `talk-reply` using the `replyTo` id from the delivered message.
- If two sessions ask each other simultaneously: the later asker yields — answer the peer's ask first, then re-ask.

### Async notifications

- Use `talk-send` for heads-ups that do not block: send and keep working.
- Messages deliver on the next natural turn by default (`queue`); `steer` interrupts the peer immediately — behavior depends on the `talk.deliver` setting.

### Cross-session review

- Ask another session to review your changes: `talk-send` the file paths plus a diff summary, request a review, and let it reply.
- Send paths and summaries, not whole file contents — the peer can `read` them itself.

## Message style

- Plain text, ≤32KB. Send a summary and paths, never the full file or large code blocks.
- Self-contained: background, goal, constraints — the peer has none of your context.
- Make the ask explicit: "please review", "please implement", or "FYI only".
- One topic per message so the reply stays focused.
- No empty pleasantries: skip "received, thanks for the sync" / "nice collaborating with you" / "thanks, noted". An acknowledgment with no new information wastes a peer's turn — send facts, questions, or decisions, not ceremony.

## Pitfalls

- **Avoid message loops**: if the peer sent you something or is asking you, answer it before sending new ones. Two agents pinging each other deadlock.
- **Address from known ids**: only run `talk-list-sessions` to discover sessions or verify an id. If you already hold a valid id (e.g. from an incoming message or a previous listing), send directly — an unknown or invisible id is refused with `Unknown session id`.
- **Respect status**: asking an offline session blocks until the 30 min timeout. Prefer `talk-send` there — the message queues on disk and the peer receives it when it resumes.
- **Visibility boundary**: you can only collaborate with sessions you can see; invisible sessions are unreachable by design.
