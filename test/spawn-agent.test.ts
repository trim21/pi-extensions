/**
 * Tests for the spawn_agent extension core:
 * - discoverAgents: frontmatter parsing and validation
 * - buildSubagentArgs: CLI argument assembly (read-only default toolset)
 * - tool registration metadata
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildSubagentArgs,
  formatAgentListSection,
  forwardSubagentUIRequest,
} from "../src/spawn-agent.js";
import { discoverAgents } from "../src/spawn-agent-agents.js";

function withTempDir(files: Record<string, string>, fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "spawn-agent-test-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, "utf8");
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SCOUT = `---
name: scout
description: Fast codebase recon
tools:
  - read
  - grep
  - find
  - ls
  - bash
model: claude-haiku-4-5
thinkingLevel: high
---
You are a scout agent.
`;

describe("discoverAgents", () => {
  it("parses name, description, tools, model and thinkingLevel from frontmatter", () => {
    withTempDir({ "scout.md": SCOUT }, (dir) => {
      const agents = discoverAgents(dir);
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        name: "scout",
        description: "Fast codebase recon",
        tools: ["read", "grep", "find", "ls", "bash"],
        model: "claude-haiku-4-5",
        thinkingLevel: "high",
        systemPrompt: "You are a scout agent.",
      });
    });
  });

  it("leaves tools undefined when the agent declares none", () => {
    const md = `---
name: reader
description: Read-only reviewer
---
Just read files.
`;
    withTempDir({ "reader.md": md }, (dir) => {
      const [agent] = discoverAgents(dir);
      expect(agent.tools).toBeUndefined();
      expect(agent.model).toBeUndefined();
    });
  });

  it("skips files whose frontmatter fails typebox validation", () => {
    withTempDir(
      {
        "no-name.md": "---\ndescription: x\n---\nbody",
        "no-desc.md": "---\nname: x\n---\nbody",
        "tools-as-string.md": "---\nname: x\ndescription: y\ntools: read, grep\n---\nbody",
        "name-as-number.md": "---\nname: 123\ndescription: y\n---\nbody",
        "bad-thinking-level.md": "---\nname: x\ndescription: y\nthinkingLevel: extreme\n---\nbody",
        "notes.txt": "---\nname: x\ndescription: y\n---\nbody",
        "valid.md": "---\nname: v\ndescription: ok\ntools:\n  - read\n---\nbody",
      },
      (dir) => {
        const agents = discoverAgents(dir);
        expect(agents).toHaveLength(1);
        expect(agents[0].name).toBe("v");
      },
    );
  });

  it("returns an empty list for a missing directory", () => {
    expect(discoverAgents(join(tmpdir(), "definitely-not-here"))).toEqual([]);
  });
});

/** Extract the file paths passed via `-e` flags. 分隔符统一为 `/`，断言跨平台。 */
function loadedExtensions(args: string[]): string[] {
  const exts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e" && args[i + 1]) exts.push(args[i + 1].replaceAll("\\", "/"));
  }
  return exts;
}

describe("buildSubagentArgs", () => {
  const baseAgent = {
    name: "scout",
    description: "desc",
    systemPrompt: "",
    filePath: "/x/scout.md",
  };

  it("uses the read-only default toolset when the agent declares none", () => {
    const args = buildSubagentArgs(baseAgent, "find the config", undefined);
    expect(args).toContain("rpc");
    expect(args).not.toContain("-p");
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--tools");
    const toolsIdx = args.indexOf("--tools");
    expect(args[toolsIdx + 1]).toBe("read,grep,find,ls");
    expect(args).not.toContain("Task: find the config");
  });

  it("loads the bwrap-backed opencode bash for agents that declare the bash tool", () => {
    for (const agent of [
      { ...baseAgent, tools: ["bash"] },
      { ...baseAgent, tools: ["bash", "edit"] },
    ]) {
      const exts = loadedExtensions(buildSubagentArgs(agent, "task", undefined));
      expect(exts.some((p) => p.endsWith("opencode/bash.ts"))).toBe(true);
    }
    // Agents without bash need no bwrap sandbox: there are no commands to run.
    const exts = loadedExtensions(buildSubagentArgs(baseAgent, "task", undefined));
    expect(exts.some((p) => p.endsWith("opencode/bash.ts"))).toBe(false);
  });

  it("loads opencode-read for the default read-only toolset", () => {
    const exts = loadedExtensions(buildSubagentArgs(baseAgent, "task", undefined));
    expect(exts.some((p) => p.endsWith("opencode/read.ts"))).toBe(true);
    expect(exts.some((p) => p.endsWith("opencode/edit.ts"))).toBe(false);
    expect(exts.some((p) => p.endsWith("opencode/write.ts"))).toBe(false);
  });

  it("loads opencode overrides for each declared tool (read/edit/write/bash)", () => {
    const exts = loadedExtensions(
      buildSubagentArgs(
        { ...baseAgent, tools: ["read", "edit", "write", "bash"] },
        "task",
        undefined,
      ),
    );
    expect(exts.some((p) => p.endsWith("opencode/read.ts"))).toBe(true);
    expect(exts.some((p) => p.endsWith("opencode/edit.ts"))).toBe(true);
    expect(exts.some((p) => p.endsWith("opencode/write.ts"))).toBe(true);
    expect(exts.some((p) => p.endsWith("opencode/bash.ts"))).toBe(true);
  });

  it("does not load opencode overrides for tools the agent did not declare", () => {
    const exts = loadedExtensions(
      buildSubagentArgs({ ...baseAgent, tools: ["bash"] }, "task", undefined),
    );
    expect(exts.some((p) => p.endsWith("opencode/read.ts"))).toBe(false);
    expect(exts.some((p) => p.endsWith("opencode/edit.ts"))).toBe(false);
    expect(exts.some((p) => p.endsWith("opencode/write.ts"))).toBe(false);
    expect(exts.some((p) => p.endsWith("opencode/bash.ts"))).toBe(true);
  });

  it("loads claude-code search tools individually (Grep without Glob)", () => {
    const grepExts = loadedExtensions(
      buildSubagentArgs({ ...baseAgent, tools: ["Grep"] }, "task", undefined),
    );
    expect(grepExts.some((p) => p.endsWith("claude-code/grep.ts"))).toBe(true);
    expect(grepExts.some((p) => p.endsWith("claude-code/glob.ts"))).toBe(false);

    const globExts = loadedExtensions(
      buildSubagentArgs({ ...baseAgent, tools: ["Glob"] }, "task", undefined),
    );
    expect(globExts.some((p) => p.endsWith("claude-code/glob.ts"))).toBe(true);
    expect(globExts.some((p) => p.endsWith("claude-code/grep.ts"))).toBe(false);

    const both = loadedExtensions(
      buildSubagentArgs({ ...baseAgent, tools: ["Grep", "Glob"] }, "task", undefined),
    );
    expect(both.some((p) => p.endsWith("claude-code/grep.ts"))).toBe(true);
    expect(both.some((p) => p.endsWith("claude-code/glob.ts"))).toBe(true);
  });

  it("loads the shared cc files implementation once for Read/Edit/Write", () => {
    // All three stateful cc tools live in claude-code/files.ts (shared
    // read-snapshot state); the `--tools` allowlist exposes only the subset
    // the agent declared, so the extension file must be loaded exactly once.
    const exts = loadedExtensions(
      buildSubagentArgs({ ...baseAgent, tools: ["Read", "Edit", "Write"] }, "task", undefined),
    );
    expect(exts.filter((p) => p.endsWith("claude-code/files.ts"))).toHaveLength(1);
    expect(exts.some((p) => p.endsWith("opencode/read.ts"))).toBe(false);
    expect(exts.some((p) => p.endsWith("opencode/edit.ts"))).toBe(false);
    expect(exts.some((p) => p.endsWith("opencode/write.ts"))).toBe(false);

    const single = loadedExtensions(
      buildSubagentArgs({ ...baseAgent, tools: ["Edit"] }, "task", undefined),
    );
    expect(single.filter((p) => p.endsWith("claude-code/files.ts"))).toHaveLength(1);
  });

  it("uses the agent's declared toolset and model when present", () => {
    const args = buildSubagentArgs(
      { ...baseAgent, tools: ["bash", "edit"], model: "claude-sonnet-4" },
      "implement",
      undefined,
    );
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4");
    expect(args[args.indexOf("--tools") + 1]).toBe("bash,edit");
  });

  it("appends the thinking level to the model id as a suffix", () => {
    const args = buildSubagentArgs(
      { ...baseAgent, model: "claude-sonnet-4", thinkingLevel: "high" },
      "task",
      undefined,
    );
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4:high");
  });

  it("ignores the thinking level when no model is declared", () => {
    const args = buildSubagentArgs({ ...baseAgent, thinkingLevel: "max" }, "task", undefined);
    expect(args).not.toContain("--model");
  });

  it("appends the system prompt file path", () => {
    const args = buildSubagentArgs(baseAgent, "task", "/tmp/pi-spawn-agent-x/prompt-scout.md");
    expect(args).toContain("--append-system-prompt");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(
      "/tmp/pi-spawn-agent-x/prompt-scout.md",
    );
  });
});

describe("formatAgentListSection", () => {
  it("lists agent names with their descriptions", () => {
    const section = formatAgentListSection([
      { name: "scout", description: "Fast codebase recon", systemPrompt: "", filePath: "" },
      { name: "reviewer", description: "Code review", systemPrompt: "", filePath: "" },
    ]);
    expect(section).toContain("## Available subagents");
    expect(section).toContain("`scout`: Fast codebase recon");
    expect(section).toContain("`reviewer`: Code review");
    expect(section).toContain("spawn-agent");
  });
});

describe("tool registration", () => {
  // Windows 上扩展整体禁用（见下方 "Windows: spawn-agent disabled"），
  // 注册行为只属于非 Windows 平台语义。
  it.skipIf(process.platform === "win32")(
    "registers a spawn-agent tool with agent and task parameters",
    async () => {
      const { default: spawnAgent } = await import("../src/spawn-agent.js");
      let tool: { name: string; parameters: unknown } | undefined;
      spawnAgent({
        registerTool: (def: { name: string; parameters: unknown }) => {
          tool = def;
        },
        on: () => false,
      } as never);

      expect(tool?.name).toBe("spawn-agent");
      expect(tool?.parameters).toBeDefined();
    },
  );

  it.skipIf(process.platform === "win32")(
    "appends the agent list to the system prompt on agent start",
    async () => {
      vi.resetModules();
      vi.doMock("../src/spawn-agent-agents.js", async (importOriginal) => {
        const mod = await importOriginal<typeof import("../src/spawn-agent-agents.js")>();
        return {
          ...mod,
          discoverAgents: () => [
            { name: "scout", description: "Fast recon", systemPrompt: "", filePath: "" },
          ],
        };
      });

      const { default: spawnAgent } = await import("../src/spawn-agent.js");
      let handler:
        ((event: { systemPrompt: string }) => { systemPrompt: string } | undefined) | undefined;
      spawnAgent({
        registerTool: () => false,
        on: (event: string, h: unknown) => {
          if (event === "before_agent_start") handler = h as never;
        },
      } as never);

      expect(handler).toBeTypeOf("function");

      const basePrompt = "You are pi, a coding agent.";
      const result = handler?.({ systemPrompt: basePrompt });
      expect(result?.systemPrompt).toContain(basePrompt);
      expect(result?.systemPrompt).toContain("## Available subagents");
      expect(result?.systemPrompt).toContain("`scout`: Fast recon");
      vi.resetModules();
    },
  );
});

describe("Windows: spawn-agent disabled", () => {
  // 无论测试跑在哪个平台都模拟 win32：Windows 上扩展整体禁用，不注册
  // 任何工具，session 启动时提示禁用原因。
  it("registers no tool and notifies at session start", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const { default: spawnAgent } = await import("../src/spawn-agent.js");
      const tools: unknown[] = [];
      let sessionStart:
        | ((
            event: unknown,
            ctx: { ui: { notify: (message: string, type?: string) => void } },
          ) => void)
        | undefined;
      spawnAgent({
        registerTool: (def: unknown) => {
          tools.push(def);
        },
        on: (event: string, h: unknown) => {
          if (event === "session_start") sessionStart = h as never;
        },
      } as never);

      expect(tools).toHaveLength(0);

      const notify = vi.fn();
      sessionStart?.({}, { ui: { notify } });
      expect(notify).toHaveBeenCalledWith("spawn-agent is disabled on Windows.", "warning");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

function fakeProc() {
  const proc = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  stdin.write = vi.fn(() => true);
  stdin.end = vi.fn();
  (proc as unknown as { stdin: EventEmitter }).stdin = stdin;
  (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (proc as unknown as { kill: () => boolean }).kill = () => true;
  (proc as unknown as { killed: boolean }).killed = false;
  return proc;
}

describe("subagent RPC process", () => {
  it("sends the task over stdin", async () => {
    vi.resetModules();
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", async (importOriginal) => {
      const mod = await importOriginal<typeof import("node:child_process")>();
      spawnMock.mockImplementation(fakeProc);
      return { ...mod, spawn: spawnMock };
    });

    const { runAgent } = await import("../src/spawn-agent.js");
    const agent = { name: "scout", description: "desc", systemPrompt: "", filePath: "/x/scout.md" };
    const running = runAgent(agent, "task", "/cwd", undefined, undefined);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const options = (
      spawnMock.mock.calls[0] as [string, string[], { env: Record<string, string> }]
    )[2];
    expect(options.env.PATH).toBe(process.env.PATH);

    const proc = spawnMock.mock.results[0].value as unknown as {
      stdin: { write: ReturnType<typeof vi.fn> };
    };
    expect(proc.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ type: "prompt", message: "Task: task" })}\n`,
    );

    (spawnMock.mock.results[0].value as EventEmitter).emit("close", 0);
    const result = await running;
    expect(result.exitCode).toBe(0);
    vi.resetModules();
  });
});

describe("subagent UI forwarding", () => {
  it("forwards every RPC-supported UI method to the parent UI", async () => {
    const ui = {
      select: vi.fn(async () => "Allow"),
      confirm: vi.fn(async () => true),
      input: vi.fn(async () => "because"),
      editor: vi.fn(async () => "edited"),
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setTitle: vi.fn(),
      setEditorText: vi.fn(),
    };

    await expect(
      forwardSubagentUIRequest(
        {
          type: "extension_ui_request",
          id: "1",
          method: "select",
          title: "Pick",
          options: ["Allow"],
        },
        ui as never,
      ),
    ).resolves.toEqual({ type: "extension_ui_response", id: "1", value: "Allow" });
    await expect(
      forwardSubagentUIRequest(
        {
          type: "extension_ui_request",
          id: "2",
          method: "confirm",
          title: "Sure?",
          message: "Really?",
        },
        ui as never,
      ),
    ).resolves.toEqual({ type: "extension_ui_response", id: "2", confirmed: true });
    await expect(
      forwardSubagentUIRequest(
        { type: "extension_ui_request", id: "3", method: "input", title: "Why?" },
        ui as never,
      ),
    ).resolves.toEqual({ type: "extension_ui_response", id: "3", value: "because" });
    await expect(
      forwardSubagentUIRequest(
        { type: "extension_ui_request", id: "4", method: "editor", title: "Edit" },
        ui as never,
      ),
    ).resolves.toEqual({ type: "extension_ui_response", id: "4", value: "edited" });

    await forwardSubagentUIRequest(
      {
        type: "extension_ui_request",
        id: "5",
        method: "notify",
        message: "Done",
        notifyType: "info",
      },
      ui as never,
    );
    await forwardSubagentUIRequest(
      {
        type: "extension_ui_request",
        id: "6",
        method: "setStatus",
        statusKey: "child",
        statusText: "busy",
      },
      ui as never,
    );
    await forwardSubagentUIRequest(
      {
        type: "extension_ui_request",
        id: "7",
        method: "setWidget",
        widgetKey: "child",
        widgetLines: ["one"],
        widgetPlacement: "belowEditor",
      },
      ui as never,
    );
    await forwardSubagentUIRequest(
      { type: "extension_ui_request", id: "8", method: "setTitle", title: "Child" },
      ui as never,
    );
    await forwardSubagentUIRequest(
      { type: "extension_ui_request", id: "9", method: "set_editor_text", text: "draft" },
      ui as never,
    );

    expect(ui.notify).toHaveBeenCalledWith("Done", "info");
    expect(ui.setStatus).toHaveBeenCalledWith("child", "busy");
    expect(ui.setWidget).toHaveBeenCalledWith("child", ["one"], {
      placement: "belowEditor",
    });
    expect(ui.setTitle).toHaveBeenCalledWith("Child");
    expect(ui.setEditorText).toHaveBeenCalledWith("draft");
  });

  it("writes dialog responses back to the child RPC process", async () => {
    vi.resetModules();
    const spawnMock = vi.fn();
    vi.doMock("node:child_process", async (importOriginal) => {
      const mod = await importOriginal<typeof import("node:child_process")>();
      spawnMock.mockImplementation(fakeProc);
      return { ...mod, spawn: spawnMock };
    });

    const { runAgent } = await import("../src/spawn-agent.js");
    const agent = {
      name: "scout",
      description: "desc",
      systemPrompt: "",
      filePath: "/x/scout.md",
    };
    const parentUI = { select: vi.fn(async () => "Approve once") };
    const running = runAgent(agent, "task", "/cwd", undefined, undefined, parentUI as never);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    const proc = spawnMock.mock.results[0].value as unknown as {
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      stdout: EventEmitter;
      emit: (event: string, ...args: unknown[]) => boolean;
    };
    proc.stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "extension_ui_request",
          id: "approval",
          method: "select",
          title: "Allow?",
          options: ["Approve once", "Block"],
        })}\n`,
      ),
    );

    await vi.waitFor(() =>
      expect(proc.stdin.write).toHaveBeenCalledWith(
        `${JSON.stringify({
          type: "extension_ui_response",
          id: "approval",
          value: "Approve once",
        })}\n`,
      ),
    );
    proc.stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "agent_settled" })}\n`));
    expect(proc.stdin.end).toHaveBeenCalledOnce();
    proc.emit("close", 0);
    await running;
    vi.resetModules();
  });
});

describe("subagent progress log", () => {
  it("logs completed text blocks as text: lines", async () => {
    const updates = await runWithEvents([
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "text_end",
          contentIndex: 0,
          content: "Let me inspect the config.",
        },
      },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "Found the flag." },
      },
    ]);
    expect(updates.at(-1)).toContain("text: Let me inspect the config.");
    expect(updates.at(-1)).toContain("text: Found the flag.");
  });

  it("logs tool executions as tool: lines", async () => {
    const updates = await runWithEvents([
      {
        type: "tool_execution_start",
        toolCallId: "1",
        toolName: "read",
        args: { path: "/x/config.ts" },
      },
    ]);
    expect(updates.at(-1)).toContain("tool: read");
  });

  it("merges consecutive executions of the same tool into a count", async () => {
    const updates = await runWithEvents([
      { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} },
      { type: "tool_execution_start", toolCallId: "2", toolName: "read", args: {} },
      { type: "tool_execution_start", toolCallId: "3", toolName: "read", args: {} },
    ]);
    expect(updates.at(-1)).toContain("tool: read x 3");
  });

  it("lists different tools in call order, counting only consecutive repeats", async () => {
    const updates = await runWithEvents([
      { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} },
      { type: "tool_execution_start", toolCallId: "2", toolName: "read", args: {} },
      { type: "tool_execution_start", toolCallId: "3", toolName: "glob", args: {} },
      { type: "tool_execution_start", toolCallId: "4", toolName: "read", args: {} },
      { type: "tool_execution_start", toolCallId: "5", toolName: "ls", args: {} },
    ]);
    expect(updates.at(-1)).toContain("tool: read x 2, glob, read, ls");
  });

  it("starts a fresh tool line after a text block", async () => {
    const updates = await runWithEvents([
      { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Found it." },
      },
      { type: "tool_execution_start", toolCallId: "2", toolName: "read", args: {} },
    ]);
    const lines = updates.at(-1)!.split("\n");
    expect(lines[0]).toBe("tool: read");
    expect(lines[1]).toBe("text: Found it.");
    expect(lines[2]).toBe("tool: read");
  });

  it("interleaves tool: and text: lines in event order", async () => {
    const updates = await runWithEvents([
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Reading now." },
      },
      { type: "tool_execution_start", toolCallId: "1", toolName: "grep", args: { pattern: "x" } },
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Done." },
      },
    ]);
    const lines = updates.at(-1)!.split("\n");
    expect(lines[0]).toBe("text: Reading now.");
    expect(lines[1]).toBe("tool: grep");
    expect(lines[2]).toBe("text: Done.");
  });

  it("keeps only the most recent 5 lines", async () => {
    // 3 组「4 个连续工具调用 + 一个文本块」共产生 6 行;合并后的工具行按
    // 单行参与滚动窗口,最后只保留 5 行,第 1 行(组 0 的工具行)被挤掉。
    const events: unknown[] = [];
    for (let g = 0; g < 3; g++) {
      for (let i = 0; i < 4; i++) {
        events.push({
          type: "tool_execution_start",
          toolCallId: `${g}-${i}`,
          toolName: `tool${g * 4 + i}`,
          args: {},
        });
      }
      events.push({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: `done${g}` },
      });
    }
    const updates = await runWithEvents(events);
    const lines = updates.at(-1)!.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe("text: done0");
    expect(lines[1]).toBe("tool: tool4, tool5, tool6, tool7");
    expect(lines[2]).toBe("text: done1");
    expect(lines[3]).toBe("tool: tool8, tool9, tool10, tool11");
    expect(lines[4]).toBe("text: done2");
  });
});

async function runWithEvents(events: unknown[]) {
  vi.resetModules();
  const spawnMock = vi.fn();
  vi.doMock("node:child_process", async (importOriginal) => {
    const mod = await importOriginal<typeof import("node:child_process")>();
    spawnMock.mockImplementation(fakeProc);
    return { ...mod, spawn: spawnMock };
  });

  const { runAgent } = await import("../src/spawn-agent.js");
  const agent = { name: "scout", description: "desc", systemPrompt: "", filePath: "/x/scout.md" };
  const updates: string[] = [];
  const running = runAgent(agent, "task", "/cwd", undefined, (u) => {
    const part = u.content[0];
    if (part.type === "text") updates.push(part.text);
  });

  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
  const proc = spawnMock.mock.results[0].value as unknown as {
    stdout: EventEmitter;
    emit: (event: string, ...args: unknown[]) => boolean;
  };
  for (const event of events) {
    proc.stdout.emit("data", Buffer.from(`${JSON.stringify(event)}\n`));
  }
  proc.emit("close", 0);
  await running;
  vi.resetModules();
  return updates;
}
