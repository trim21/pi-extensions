/**
 * Tests for the spawn_agent extension core:
 * - discoverAgents: frontmatter parsing and validation
 * - overrideExtensionPaths / resolveModel: SDK session assembly
 * - runAgent: session lifecycle, progress log, abort, error handling
 * - tool registration metadata
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  formatAgentListSection,
  formatSubagentError,
  overrideExtensionPaths,
  resolveModel,
  runAgent,
  type SubagentSession,
} from "../src/spawn-agent.js";
import {
  applyAgentDefaults,
  discoverAgents,
  loadSpawnAgentConfig,
  type SpawnAgentDefaults,
} from "../src/spawn-agent-agents.js";

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

  it("parses provider from frontmatter", () => {
    withTempDir({ "p.md": "---\nname: p\ndescription: d\nprovider: openai\n---\nbody" }, (dir) => {
      const [agent] = discoverAgents(dir);
      expect(agent.provider).toBe("openai");
    });
  });

  it("accepts thinkingLevel off and rejects max", () => {
    withTempDir(
      {
        "off.md": "---\nname: off\ndescription: d\nthinkingLevel: off\n---\nbody",
        "max.md": "---\nname: max\ndescription: d\nthinkingLevel: max\n---\nbody",
      },
      (dir) => {
        const agents = discoverAgents(dir);
        expect(agents.map((a) => a.name)).toEqual(["off"]);
      },
    );
  });
});

describe("loadSpawnAgentConfig", () => {
  it("returns undefined when spawn-agent.json is missing", () => {
    withTempDir({}, (dir) => {
      expect(
        loadSpawnAgentConfig(join(dir, "spawn-agent.json"), join(dir, "settings.json")),
      ).toBeUndefined();
    });
  });

  it("returns undefined on broken JSON or an empty config", () => {
    withTempDir({ "broken.json": "{ not json", "empty.json": "{}" }, (dir) => {
      expect(
        loadSpawnAgentConfig(join(dir, "broken.json"), join(dir, "settings.json")),
      ).toBeUndefined();
      expect(
        loadSpawnAgentConfig(join(dir, "empty.json"), join(dir, "settings.json")),
      ).toBeUndefined();
    });
  });

  it("parses provider/model/thinkingLevel from spawn-agent.json", () => {
    withTempDir(
      {
        "spawn-agent.json": JSON.stringify({
          provider: "axonhub",
          model: "deepseek-v4-flash",
          thinkingLevel: "high",
        }),
      },
      (dir) => {
        expect(
          loadSpawnAgentConfig(join(dir, "spawn-agent.json"), join(dir, "settings.json")),
        ).toEqual({
          provider: "axonhub",
          model: "deepseek-v4-flash",
          thinkingLevel: "high",
        });
      },
    );
  });

  it("falls back to settings.json top-level defaults per field", () => {
    withTempDir(
      {
        "spawn-agent.json": JSON.stringify({ model: "gpt-4o-mini" }),
        "settings.json": JSON.stringify({
          defaultProvider: "openai",
          defaultModel: "gpt-4o",
          defaultThinkingLevel: "high",
        }),
      },
      (dir) => {
        expect(
          loadSpawnAgentConfig(join(dir, "spawn-agent.json"), join(dir, "settings.json")),
        ).toEqual({
          provider: "openai",
          model: "gpt-4o-mini",
          thinkingLevel: "high",
        });
      },
    );
  });

  it("ignores invalid thinking levels from the settings fallback", () => {
    withTempDir(
      {
        "spawn-agent.json": JSON.stringify({ model: "gpt-4o-mini" }),
        "settings.json": JSON.stringify({ defaultThinkingLevel: "max" }),
      },
      (dir) => {
        expect(
          loadSpawnAgentConfig(join(dir, "spawn-agent.json"), join(dir, "settings.json")),
        ).toEqual({ model: "gpt-4o-mini" });
      },
    );
  });
});

describe("applyAgentDefaults", () => {
  const base = { name: "s", description: "d", systemPrompt: "", filePath: "/x/s.md" };
  const defaults = {
    provider: "axonhub",
    model: "deepseek-v4-flash",
    thinkingLevel: "high",
  } satisfies SpawnAgentDefaults;

  it("returns the agents unchanged when there are no defaults", () => {
    const agents = [base];
    expect(applyAgentDefaults(agents, undefined)).toBe(agents);
    expect(agents[0]).toEqual(base);
  });

  it("fills absent fields from the defaults", () => {
    const [agent] = applyAgentDefaults([base], defaults);
    expect(agent.provider).toBe("axonhub");
    expect(agent.model).toBe("deepseek-v4-flash");
    expect(agent.thinkingLevel).toBe("high");
  });

  it("lets frontmatter values win over the defaults", () => {
    const [agent] = applyAgentDefaults(
      [{ ...base, provider: "openai", model: "gpt-4o", thinkingLevel: "off" }],
      defaults,
    );
    expect(agent.provider).toBe("openai");
    expect(agent.model).toBe("gpt-4o");
    expect(agent.thinkingLevel).toBe("off");
  });

  it("merges field by field", () => {
    const [agent] = applyAgentDefaults([{ ...base, model: "gpt-4o" }], defaults);
    expect(agent.model).toBe("gpt-4o");
    expect(agent.provider).toBe("axonhub");
    expect(agent.thinkingLevel).toBe("high");
  });
});

describe("overrideExtensionPaths", () => {
  it("loads the bwrap-backed opencode bash for agents that declare the bash tool", () => {
    for (const tools of [["bash"], ["bash", "edit"]]) {
      const paths = overrideExtensionPaths(tools);
      expect(paths.some((p) => p.endsWith(join("opencode", "bash.ts")))).toBe(true);
    }
    // Agents without bash need no bwrap sandbox: there are no commands to run.
    const paths = overrideExtensionPaths(["read", "grep", "find", "ls"]);
    expect(paths.some((p) => p.endsWith(join("opencode", "bash.ts")))).toBe(false);
  });

  it("loads opencode files.ts for the default read-only toolset", () => {
    const paths = overrideExtensionPaths(["read"]);
    expect(paths.some((p) => p.endsWith(join("opencode", "files.ts")))).toBe(true);
    expect(paths.some((p) => p.endsWith(join("opencode", "bash.ts")))).toBe(false);
  });

  it("loads the shared opencode files implementation once for read/edit/write", () => {
    const paths = overrideExtensionPaths(["read", "edit", "write", "bash"]);
    // read/edit/write 共享 opencode/files.ts（共享 LSP service 实例），只加载一次
    expect(paths.filter((p) => p.endsWith(join("opencode", "files.ts")))).toHaveLength(1);
    expect(paths.some((p) => p.endsWith(join("opencode", "bash.ts")))).toBe(true);
  });

  it("does not load overrides for tools the agent did not declare", () => {
    const paths = overrideExtensionPaths(["bash"]);
    expect(paths.some((p) => p.endsWith(join("opencode", "files.ts")))).toBe(false);
    expect(paths.some((p) => p.endsWith(join("opencode", "bash.ts")))).toBe(true);
  });

  it("loads claude-code search tools individually (Grep without Glob)", () => {
    const grepPaths = overrideExtensionPaths(["Grep"]);
    expect(grepPaths.some((p) => p.endsWith(join("claude-code", "grep.ts")))).toBe(true);
    expect(grepPaths.some((p) => p.endsWith(join("claude-code", "glob.ts")))).toBe(false);

    const globPaths = overrideExtensionPaths(["Glob"]);
    expect(globPaths.some((p) => p.endsWith(join("claude-code", "glob.ts")))).toBe(true);
    expect(globPaths.some((p) => p.endsWith(join("claude-code", "grep.ts")))).toBe(false);

    const both = overrideExtensionPaths(["Grep", "Glob"]);
    expect(both.some((p) => p.endsWith(join("claude-code", "grep.ts")))).toBe(true);
    expect(both.some((p) => p.endsWith(join("claude-code", "glob.ts")))).toBe(true);
  });

  it("loads the shared cc files implementation once for Read/Edit/Write", () => {
    // All three stateful cc tools live in claude-code/files.ts (shared
    // read-snapshot state); the tools allowlist exposes only the subset the
    // agent declared, so the extension file must be loaded exactly once.
    const paths = overrideExtensionPaths(["Read", "Edit", "Write"]);
    expect(paths.filter((p) => p.endsWith(join("claude-code", "files.ts")))).toHaveLength(1);
    expect(paths.some((p) => p.endsWith(join("opencode", "files.ts")))).toBe(false);

    const single = overrideExtensionPaths(["Edit"]);
    expect(single.filter((p) => p.endsWith(join("claude-code", "files.ts")))).toHaveLength(1);
  });

  it("throws when an override extension file is missing", () => {
    // overrideExtensionPaths resolves against the installed package; a
    // missing file means the extension bundle is broken and must be fatal.
    expect(() => overrideExtensionPaths(["read"])).not.toThrow();
  });
});

function runtimeWith(models: Record<string, boolean>) {
  const getModel = vi.fn((provider: string, modelId: string) =>
    models[`${provider}/${modelId}`] ? ({ provider, id: modelId } as never) : undefined,
  );
  return {
    runtime: { getModel } as unknown as ModelRuntime,
    getModel,
  };
}

describe("resolveModel", () => {
  const settings = { getDefaultProvider: () => "openai" } as unknown as SettingsManager;

  it("returns undefined when the agent declares no model", () => {
    const { runtime, getModel } = runtimeWith({});
    expect(
      resolveModel(
        runtime,
        { name: "s", description: "d", systemPrompt: "", filePath: "" },
        settings,
      ),
    ).toBeUndefined();
    expect(getModel).not.toHaveBeenCalled();
  });

  it("splits a provider-prefixed model string", () => {
    const { runtime, getModel } = runtimeWith({ "openai/gpt-4o": true });
    const model = resolveModel(
      runtime,
      { name: "s", description: "d", systemPrompt: "", filePath: "", model: "openai/gpt-4o" },
      settings,
    );
    expect(getModel).toHaveBeenCalledWith("openai", "gpt-4o");
    expect(model).toBeDefined();
  });

  it("uses the declared provider for a bare model id", () => {
    const { runtime, getModel } = runtimeWith({ "axonhub/deepseek-v4-flash": true });
    const model = resolveModel(
      runtime,
      {
        name: "s",
        description: "d",
        systemPrompt: "",
        filePath: "",
        provider: "axonhub",
        model: "deepseek-v4-flash",
      },
      settings,
    );
    expect(getModel).toHaveBeenCalledWith("axonhub", "deepseek-v4-flash");
    expect(model).toBeDefined();
  });

  it("falls back to the settings default provider for a bare model id", () => {
    const { runtime, getModel } = runtimeWith({ "openai/gpt-4o": true });
    const model = resolveModel(
      runtime,
      { name: "s", description: "d", systemPrompt: "", filePath: "", model: "gpt-4o" },
      settings,
    );
    expect(getModel).toHaveBeenCalledWith("openai", "gpt-4o");
    expect(model).toBeDefined();
  });

  it("returns undefined when no provider can be resolved", () => {
    const runtime = runtimeWith({}).runtime;
    const model = resolveModel(
      runtime,
      { name: "s", description: "d", systemPrompt: "", filePath: "", model: "gpt-4o" },
      { getDefaultProvider: vi.fn() } as unknown as SettingsManager,
    );
    expect(model).toBeUndefined();
  });

  it("returns undefined when the model is not registered", () => {
    const runtime = runtimeWith({}).runtime;
    const model = resolveModel(
      runtime,
      {
        name: "s",
        description: "d",
        systemPrompt: "",
        filePath: "",
        provider: "openai",
        model: "gpt-4o",
      },
      settings,
    );
    expect(model).toBeUndefined();
  });
});

describe("formatAgentListSection", () => {
  it("lists agent names with their descriptions", () => {
    const section = formatAgentListSection([
      { name: "scout", description: "Fast codebase recon", systemPrompt: "", filePath: "" },
      { name: "reviewer", description: "Code review", systemPrompt: "", filePath: "" },
    ]);
    expect(section).toContain("### Available subagents");
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
    "injects the agent list via tool promptGuidelines",
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
      let guidelines: string[] | undefined;
      spawnAgent({
        registerTool: (def: { promptGuidelines?: string[] }) => {
          guidelines = def.promptGuidelines;
        },
        on: () => false,
      } as never);

      expect(guidelines).toBeDefined();
      expect(guidelines?.[0]).toContain("### Available subagents");
      expect(guidelines?.[0]).toContain("`scout`: Fast recon");
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

const BASE_AGENT = {
  name: "scout",
  description: "desc",
  systemPrompt: "",
  filePath: "/x/scout.md",
};

/** Fake session harness: runAgent drives this instead of the real SDK. */
function fakeSessionHarness() {
  const listeners: ((event: never) => void)[] = [];
  let resolvePrompt: (() => void) | undefined;
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- lib 是 ES2023
  const promptPromise = new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  });
  const subscribe = vi.fn((listener: (event: never) => void) => {
    listeners.push(listener);
    return () => {
      const index = listeners.indexOf(listener);
      if (index !== -1) listeners.splice(index, 1);
    };
  });
  // 挂起直到测试 settle()，与真实 SDK 中 prompt 在事件流之后才 resolve 的时序一致。
  const prompt = vi.fn(() => promptPromise);
  const abort = vi.fn(async () => resolvePrompt?.());
  const dispose = vi.fn();
  const session = {
    agent: { state: { messages: [] as AgentMessage[] } },
    subscribe,
    prompt,
    abort,
    dispose,
  } as unknown as SubagentSession;
  return {
    session,
    factory: vi.fn(async () => session),
    emit: (event: unknown) => {
      for (const listener of listeners) listener(event as never);
    },
    settle: () => resolvePrompt?.(),
    subscribe,
    prompt,
    abort,
    dispose,
  };
}

describe("subagent session", () => {
  it("prompts the session with the task", async () => {
    const h = fakeSessionHarness();
    const running = runAgent(
      BASE_AGENT,
      "task",
      "/cwd",
      undefined,
      undefined,
      undefined,
      h.factory,
    );
    h.settle();
    const result = await running;
    expect(h.prompt).toHaveBeenCalledWith("Task: task", { source: "rpc" });
    expect(result.exitCode).toBe(0);
  });

  it("records a session creation failure", async () => {
    const factory = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await runAgent(
      BASE_AGENT,
      "task",
      "/cwd",
      undefined,
      undefined,
      undefined,
      factory,
    );
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("boom");
    expect(result.stopReason).toBe("error");
  });

  it("records a prompt rejection as an error", async () => {
    const h = fakeSessionHarness();
    h.session.prompt = vi.fn(async () => {
      throw new Error("no api key");
    });
    const result = await runAgent(
      BASE_AGENT,
      "task",
      "/cwd",
      undefined,
      undefined,
      undefined,
      h.factory,
    );
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("no api key");
    expect(result.stopReason).toBe("error");
  });

  it("marks the result aborted when the abort signal fires", async () => {
    const h = fakeSessionHarness();
    const controller = new AbortController();
    const running = runAgent(
      BASE_AGENT,
      "task",
      "/cwd",
      controller.signal,
      undefined,
      undefined,
      h.factory,
    );
    controller.abort();
    const result = await running;
    expect(h.abort).toHaveBeenCalled();
    expect(result.stopReason).toBe("aborted");
    expect(result.exitCode).toBe(1);
  });

  it("keeps an existing stop reason when the abort signal fires after settling", async () => {
    const h = fakeSessionHarness();
    const controller = new AbortController();
    const running = runAgent(
      BASE_AGENT,
      "task",
      "/cwd",
      controller.signal,
      undefined,
      undefined,
      h.factory,
    );
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalled());
    h.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { cost: { total: 0 }, totalTokens: 0 },
        stopReason: "end_turn",
      },
    });
    controller.abort();
    const result = await running;
    expect(result.stopReason).toBe("end_turn");
    expect(result.exitCode).toBe(0);
  });
  it("passes the parent UI to the session factory", async () => {
    const h = fakeSessionHarness();
    const parentUI = { select: vi.fn() } as never;
    const running = runAgent(BASE_AGENT, "task", "/cwd", undefined, undefined, parentUI, h.factory);
    h.settle();
    await running;
    expect(h.factory).toHaveBeenCalledWith(BASE_AGENT, "/cwd", parentUI);
  });

  it("disposes the session after the prompt settles", async () => {
    const h = fakeSessionHarness();
    const running = runAgent(
      BASE_AGENT,
      "task",
      "/cwd",
      undefined,
      undefined,
      undefined,
      h.factory,
    );
    h.settle();
    await running;
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it("collects messages and usage from message_end events", async () => {
    const h = fakeSessionHarness();
    const running = runAgent(
      BASE_AGENT,
      "task",
      "/cwd",
      undefined,
      undefined,
      undefined,
      h.factory,
    );
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalled());
    h.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "found it" }],
        usage: { cost: { total: 0.0123 }, totalTokens: 456 },
        model: "claude-haiku-4-5",
        stopReason: "end_turn",
      },
    });
    h.settle();
    const result = await running;
    expect(result.usage.cost).toBe(0.0123);
    expect(result.usage.turns).toBe(1);
    expect(result.usage.contextTokens).toBe(456);
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.stopReason).toBe("end_turn");
    expect(result.messages).toHaveLength(1);
  });

  it("ignores non-assistant message_end events for usage", async () => {
    const h = fakeSessionHarness();
    const running = runAgent(
      BASE_AGENT,
      "task",
      "/cwd",
      undefined,
      undefined,
      undefined,
      h.factory,
    );
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalled());
    h.emit({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    h.settle();
    const result = await running;
    expect(result.usage.turns).toBe(0);
    expect(result.messages).toHaveLength(1);
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
    expect(updates.at(-1)).toContain("text: Let me in … e config.");
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
    // 工具名用单字符,让合并行(12 字符)不触发折叠,完整验证合并结果。
    const updates = await runWithEvents([
      { type: "tool_execution_start", toolCallId: "1", toolName: "a", args: {} },
      { type: "tool_execution_start", toolCallId: "2", toolName: "a", args: {} },
      { type: "tool_execution_start", toolCallId: "3", toolName: "b", args: {} },
      { type: "tool_execution_start", toolCallId: "4", toolName: "a", args: {} },
      { type: "tool_execution_start", toolCallId: "5", toolName: "c", args: {} },
    ]);
    expect(updates.at(-1)).toContain("tool: a x 2, b, a, c");
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

  it("folds long text block content to first/last 9 chars", async () => {
    const long = "a".repeat(120);
    const updates = await runWithEvents([
      {
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: long },
      },
    ]);
    expect(updates.at(-1)).toContain(`text: ${"a".repeat(9)} … ${"a".repeat(9)}`);
    expect(updates.at(-1)).not.toContain(`text: ${"a".repeat(10)}`);
  });

  it("folds long merged tool lines to first/last 9 chars", async () => {
    const names = [
      "alpha-tool-with-a-very-long-name",
      "beta-tool-with-a-very-long-name",
      "gamma-tool-with-a-very-long-name",
    ];
    const updates = await runWithEvents(
      names.map((name, i) => ({
        type: "tool_execution_start",
        toolCallId: String(i),
        toolName: name,
        args: {},
      })),
    );
    expect(updates.at(-1)).toContain("tool: alpha-too … long-name");
    expect(updates.at(-1)).not.toContain("beta-tool");
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
    expect(lines[1]).toBe("tool: tool4, to … l6, tool7");
    expect(lines[2]).toBe("text: done1");
    expect(lines[3]).toBe("tool: tool8, to … 0, tool11");
    expect(lines[4]).toBe("text: done2");
  });
});

async function runWithEvents(events: unknown[]) {
  const h = fakeSessionHarness();
  const updates: string[] = [];
  const running = runAgent(
    BASE_AGENT,
    "task",
    "/cwd",
    undefined,
    (u) => {
      const part = u.content[0];
      if (part.type === "text") updates.push(part.text);
    },
    undefined,
    h.factory,
  );
  await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalled());
  for (const event of events) {
    h.emit(event);
  }
  h.settle();
  await running;
  return updates;
}

describe("formatSubagentError", () => {
  const base = {
    agent: "scout",
    task: "task",
    exitCode: 1,
    messages: [] as AgentMessage[],
    stderr: "",
    usage: { cost: 0, contextTokens: 0, turns: 0 },
  };

  it("falls back to (no output) when nothing is available", () => {
    expect(formatSubagentError(base)).toEqual({ reason: "exit 1", message: "(no output)" });
  });

  it("uses the stop reason and error message", () => {
    expect(formatSubagentError({ ...base, stopReason: "error", errorMessage: "boom" })).toEqual({
      reason: "error",
      message: "error: boom",
    });
  });

  it("combines error, stderr and output by source", () => {
    const { message } = formatSubagentError({
      ...base,
      errorMessage: "no api key",
      stderr: "some log line\nfatal: cannot start",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "I looked but failed." }],
        } as AgentMessage,
      ],
    });
    expect(message).toBe(
      "error: no api key\nstderr: some log line\nfatal: cannot start\noutput: I looked but failed.",
    );
  });

  it("truncates long stderr to the tail with a marker", () => {
    const long = "x".repeat(10_000);
    const { message } = formatSubagentError({ ...base, stderr: `${long}\nerror at the end` });
    expect(message.startsWith("stderr: ")).toBe(true);
    expect(message).toContain("error at the end");
    expect(message).toContain("[stderr truncated]");
    expect(message.length).toBeLessThan(5_000);
  });
});
