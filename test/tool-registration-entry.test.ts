/**
 * 统一入口（src/index.ts）的注册行为：按配置选工具集、按模型判定、禁用/启用
 * 规则、模块失败隔离。
 *
 * 重模块（aft / talk / github / spawn-agent / web / vision）被 mock 掉：本文件
 * 测的是注册层，不测这些模块自身的行为。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 每个用例都要 vi.resetModules() 后重新 import 整个入口（含 codemode 注册时的 wasm 编译）：
// 第一条在 CI 冷缓存上要 5 秒上下，默认 5s 超时会随机判定失败。这是真实的加载成本，不是挂住，
// 因此只给本文件放宽超时。
vi.setConfig({ testTimeout: 30_000 });

const moduleRegistrations: { name: string; registered: string[] }[] = [];
let failingModule: string | undefined;

function fakeModule(name: string, toolNames: string[]) {
  return {
    register: () => {
      moduleRegistrations.push({ name, registered: toolNames });
      if (failingModule === name) {
        throw new Error(`${name} exploded`);
      }
    },
  };
}

vi.mock("../src/gh/index.js", () => ({
  createGithubTools: () => fakeModule("github", ["read-github-pr", "list-github-issues"]),
}));
vi.mock("../src/talk/index.js", () => ({
  createTalkTools: () => fakeModule("talk", ["talk-send", "talk-ask"]),
}));
vi.mock("../src/aft/index.js", () => ({
  createAftTools: () => ({
    registerForSession: async () => {
      moduleRegistrations.push({ name: "aft", registered: ["aft_outline"] });
      if (failingModule === "aft") {
        throw new Error("aft exploded");
      }
    },
  }),
}));
vi.mock("../src/spawn-agent.js", () => ({
  createSpawnAgentTool: () => fakeModule("spawn-agent", ["spawn-agent"]),
}));
vi.mock("../src/vision-agent.js", () => ({
  createVisionTools: () => fakeModule("vision", ["describe_image"]),
}));
vi.mock("../src/web/search.js", () => ({
  createWebSearchTool: () => fakeModule("web_search", ["web_search"]),
}));
vi.mock("../src/web/fetch.js", () => ({
  createFetchTools: () => fakeModule("web_fetch", ["web_fetch"]),
  createWebFetch: () => fakeModule("web_fetch", ["web_fetch"]),
}));

interface Loaded {
  toolNames: string[];
  notifications: string[];
}

let agentDir: string;
let realAgentDir: string | undefined;

/** 用给定配置加载入口，并按注册顺序派发一次 session_start。 */
const DEFAULT_MODEL = { id: "gpt-5.6" };

async function loadEntry(
  config: unknown,
  model: { id: string; provider?: string } | undefined = DEFAULT_MODEL,
): Promise<Loaded> {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(config === undefined ? {} : { personalExtensions: config }),
  );

  const tools = new Map<string, { name: string }>();
  const notifications: string[] = [];
  const handlers: ((event: unknown, ctx: unknown) => unknown)[] = [];
  const pi = {
    registerTool: (tool: { name: string }) => {
      if (tools.has(tool.name)) {
        throw new Error(`duplicate tool registration: ${tool.name}`);
      }
      tools.set(tool.name, tool);
    },
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    getActiveTools: () => [],
    setActiveTools: vi.fn(),
    exec: vi.fn(),
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      if (event === "session_start") {
        handlers.push(handler);
      }
    },
  } as unknown as ExtensionAPI;

  vi.resetModules();
  const { default: entry } = await import("../src/index.js");
  entry(pi);

  const ctx = {
    model,
    cwd: process.cwd(),
    ui: {
      notify: (message: string) => {
        notifications.push(message);
      },
      setStatus: vi.fn(),
      theme: { fg: () => "" },
    },
    sessionManager: { getBranch: () => [] },
  };
  for (const handler of handlers) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }
  return { toolNames: [...tools.keys()], notifications };
}

describe("统一入口的注册行为", () => {
  beforeEach(() => {
    realAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = mkdtempSync(join(tmpdir(), "pi-ext-entry-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    moduleRegistrations.length = 0;
    failingModule = undefined;
  });

  afterEach(() => {
    if (realAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = realAgentDir;
    }
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("未配置时注册 claude-code 那套文件 IO 工具", async () => {
    const { toolNames } = await loadEntry(undefined);
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Edit");
    expect(toolNames).toContain("Write");
    expect(toolNames).toContain("Grep");
    expect(toolNames).toContain("Bash");
    expect(toolNames).not.toContain("read");
    expect(toolNames).not.toContain("bash");
  });

  it("fileIo 选择 opencode 那套", async () => {
    const { toolNames } = await loadEntry({ fileIo: "opencode" });
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("bash");
    expect(toolNames).not.toContain("Read");
    expect(toolNames).not.toContain("Bash");
  });

  it("fileIoByModel 按模型切换工具集", async () => {
    const config = {
      fileIo: "claude-code",
      fileIoByModel: [{ models: ["glm-*"], fileIo: "opencode" }],
    };
    const glm = await loadEntry(config, { id: "glm-4.6" });
    expect(glm.toolNames).toContain("bash");
    expect(glm.toolNames).not.toContain("Bash");

    const gpt = await loadEntry(config, { id: "gpt-5.6" });
    expect(gpt.toolNames).toContain("Bash");
    expect(gpt.toolNames).not.toContain("bash");
  });

  it("provider/id 形式的模型名同样命中", async () => {
    const config = { fileIoByModel: [{ models: ["zhipu/glm-*"], fileIo: "opencode" }] };
    const matched = await loadEntry(config, { id: "glm-4.6", provider: "zhipu" });
    expect(matched.toolNames).toContain("read");

    const unmatched = await loadEntry(config, { id: "glm-4.6", provider: "other" });
    expect(unmatched.toolNames).toContain("Read");
  });

  it("disabledTools 支持通配，命中的工具不注册", async () => {
    const { toolNames } = await loadEntry({ disabledTools: ["talk-*"] });
    expect(toolNames).not.toContain("talk-send");
    expect(toolNames).toContain("Read");
  });

  it("enabledTools 豁免被禁用的工具", async () => {
    const { toolNames } = await loadEntry({
      disabledTools: ["*"],
      enabledTools: ["Read", "Bash"],
    });
    expect(toolNames.toSorted()).toEqual(["Bash", "Read"]);
  });

  it("带 models 的规则只在命中时生效", async () => {
    const config = { disabledTools: [{ tools: ["*"], models: ["glm-*"] }] };
    const glm = await loadEntry(config, { id: "glm-4.6" });
    expect(glm.toolNames).toEqual([]);

    const gpt = await loadEntry(config, { id: "gpt-5.6" });
    expect(gpt.toolNames).toContain("Read");
  });

  it("调试：每个工具只注册一次", async () => {
    const { toolNames } = await loadEntry(undefined);
    expect(new Set(toolNames).size).toBe(toolNames.length);
  });

  it("模块注册失败不影响其他工具，并给出警告", async () => {
    failingModule = "talk";
    const { toolNames, notifications } = await loadEntry(undefined);
    expect(toolNames).toContain("Read");
    expect(toolNames).not.toContain("talk-send");
    expect(notifications.join("\n")).toContain("talk exploded");
  });

  it("非法配置给出警告但不影响其余配置", async () => {
    const { toolNames, notifications } = await loadEntry({
      fileIo: "vim",
      disabledTools: [{ tools: "Bash" }],
    });
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Bash");
    expect(notifications.join("\n")).toContain("fileIo");
  });

  it("报告匹配不到任何工具的模式", async () => {
    const { notifications } = await loadEntry({ disabledTools: ["no-such-tool"] });
    expect(notifications.join("\n")).toContain("no-such-tool");
  });

  it("配置里的每个模块都注册一次", async () => {
    await loadEntry(undefined);
    expect(moduleRegistrations.map((entry) => entry.name).toSorted()).toEqual([
      "aft",
      "github",
      "spawn-agent",
      "talk",
      "vision",
      "web_fetch",
      "web_search",
    ]);
  });
});
