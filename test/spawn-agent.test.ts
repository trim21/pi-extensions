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

import { buildSubagentArgs, formatAgentListSection } from "../src/spawn-agent.js";
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

describe("buildSubagentArgs", () => {
  const baseAgent = {
    name: "scout",
    description: "desc",
    systemPrompt: "",
    filePath: "/x/scout.md",
  };

  it("uses the read-only default toolset when the agent declares none", () => {
    const args = buildSubagentArgs(baseAgent, "find the config", undefined);
    expect(args).toContain("--no-extensions");
    expect(args).toContain("--tools");
    const toolsIdx = args.indexOf("--tools");
    expect(args[toolsIdx + 1]).toBe("read,grep,find,ls");
    expect(args.at(-1)).toBe("Task: find the config");
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
    expect(section).toContain("spawn_agent");
  });
});

describe("tool registration", () => {
  it("registers a spawn_agent tool with agent and task parameters", async () => {
    const { default: spawnAgent } = await import("../src/spawn-agent.js");
    let tool: { name: string; parameters: unknown } | undefined;
    spawnAgent({
      registerTool: (def: { name: string; parameters: unknown }) => {
        tool = def;
      },
      on: () => false,
    } as never);

    expect(tool?.name).toBe("spawn_agent");
    expect(tool?.parameters).toBeDefined();
  });

  it("appends the agent list to the system prompt on agent start", async () => {
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
  });
});

function fakeProc() {
  const proc = new EventEmitter() as ReturnType<typeof import("node:child_process").spawn>;
  (proc as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (proc as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (proc as unknown as { kill: () => boolean }).kill = () => true;
  (proc as unknown as { killed: boolean }).killed = false;
  return proc;
}

describe("subagent process environment", () => {
  it("marks the child with PI_SUBAGENT_CHILD=1", async () => {
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
    expect(options.env.PI_SUBAGENT_CHILD).toBe("1");
    expect(options.env.PATH).toBe(process.env.PATH);

    (spawnMock.mock.results[0].value as EventEmitter).emit("close", 0);
    const result = await running;
    expect(result.exitCode).toBe(0);
    vi.resetModules();
  });
});
