import type { ConfigTier } from "@cortexkit/aft-bridge";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAftTransportPool,
  findBinary,
  readConfigTiers,
  inlineUserConfigTier,
  setActiveLogger,
} = vi.hoisted(() => ({
  createAftTransportPool: vi.fn(),
  findBinary: vi.fn(),
  readConfigTiers: vi.fn(),
  inlineUserConfigTier: vi.fn(),
  setActiveLogger: vi.fn(),
}));

vi.mock("@cortexkit/aft-bridge", () => ({
  findBinary: () => findBinary(),
  createAftTransportPool: (options: unknown) => createAftTransportPool(options),
  resolveCortexKitConfigPaths: (cwd: string) => ({
    userConfigPath: `${cwd}/aft.jsonc`,
    projectConfigPath: `${cwd}/.cortexkit/aft.jsonc`,
  }),
  resolveCortexKitStorageRoot: () => "/tmp/aft-bridge-test-storage",
  readConfigTiers: (paths: unknown) => readConfigTiers(paths),
  inlineUserConfigTier: (config: Record<string, unknown>, source?: string) =>
    inlineUserConfigTier(config, source),
  timeoutForCommand: (command: string) => (command === "callgraph" ? 60_000 : undefined),
  setActiveLogger: (logger: unknown) => setActiveLogger(logger),
  RotatingLogSink: class {
    drain() {
      return Promise.resolve();
    }
  },
}));

import { CALLGRAPH_BUILD_WAIT_MS, createAftPool, SEMANTIC_API_KEY_ENV } from "../src/aft/bridge.js";
import type { SemanticRemote } from "../src/aft/config.js";
import { createAftLogger } from "../src/aft/logger.js";

const PROJECT = "/tmp/aft-bridge-test-project";

interface PoolOptions {
  poolOptions: { childEnv: Record<string, string> };
  configOverrides: { config: ConfigTier[] };
}

async function poolOptionsFor(semantic?: SemanticRemote): Promise<PoolOptions> {
  await createAftPool(PROJECT, createAftLogger(), semantic);
  return createAftTransportPool.mock.calls[0][0] as PoolOptions;
}

function remote(overrides: Partial<SemanticRemote>): SemanticRemote {
  return {
    backend: "openai_compatible",
    baseUrl: "https://gateway.internal/v1",
    apiKeyEnv: undefined,
    apiKey: undefined,
    ...overrides,
  };
}

describe("createAftPool", () => {
  beforeEach(() => {
    createAftTransportPool.mockReset();
    findBinary.mockReset();
    readConfigTiers.mockReset();
    inlineUserConfigTier.mockReset();
    setActiveLogger.mockReset();
    createAftTransportPool.mockResolvedValue({
      setConfigureOverride: vi.fn(),
      shutdown: vi.fn(),
    });
    findBinary.mockResolvedValue("/usr/local/bin/aft");
    readConfigTiers.mockReturnValue([{ tier: "user", source: "aft.jsonc", doc: "{}" }]);
    inlineUserConfigTier.mockImplementation(
      (config: Record<string, unknown>, source?: string) =>
        [{ tier: "user", source: source ?? "inline", doc: JSON.stringify(config) }] as ConfigTier[],
    );
  });

  it("passes the engine-side wait knobs to the child", async () => {
    const { poolOptions } = await poolOptionsFor();
    expect(poolOptions.childEnv).toMatchObject({
      AFT_CALLGRAPH_BUILD_WAIT_MS: String(CALLGRAPH_BUILD_WAIT_MS),
      AFT_WAIT_FOR_SEMANTIC_READY: "1",
      AFT_WAIT_FOR_SEMANTIC_READY_MS: "600000",
    });
  });

  it("keeps the callgraph wait window below its transport budget", async () => {
    // 窗口若不小于 transport 预算，客户端先超时并升级为 kill bridge。
    expect(CALLGRAPH_BUILD_WAIT_MS).toBeGreaterThan(0);
    expect(CALLGRAPH_BUILD_WAIT_MS).toBeLessThan(60_000);
  });

  it("injects no credentials when the config has none", async () => {
    const { poolOptions, configOverrides } = await poolOptionsFor(remote({}));
    expect(poolOptions.childEnv[SEMANTIC_API_KEY_ENV]).toBeUndefined();
    expect(configOverrides.config).toHaveLength(1);
    expect(inlineUserConfigTier).not.toHaveBeenCalled();
  });

  it("injects a configured key under the internal variable name and tells aft to read it", async () => {
    const { poolOptions, configOverrides } = await poolOptionsFor(
      remote({ apiKey: "sk-test-value" }),
    );
    expect(poolOptions.childEnv[SEMANTIC_API_KEY_ENV]).toBe("sk-test-value");
    const appended = configOverrides.config.at(-1);
    expect(appended?.tier).toBe("user");
    expect(JSON.parse(appended?.doc ?? "{}")).toEqual({
      semantic: { api_key_env: SEMANTIC_API_KEY_ENV },
    });
  });

  it("honours a user-specified variable name without appending a config tier", async () => {
    const { poolOptions, configOverrides } = await poolOptionsFor(
      remote({ apiKey: "sk-test-value", apiKeyEnv: "MY_EMBED_KEY" }),
    );
    expect(poolOptions.childEnv.MY_EMBED_KEY).toBe("sk-test-value");
    expect(poolOptions.childEnv[SEMANTIC_API_KEY_ENV]).toBeUndefined();
    expect(configOverrides.config).toHaveLength(1);
    expect(inlineUserConfigTier).not.toHaveBeenCalled();
  });

  it("keeps the secret out of the config docs handed to the engine", async () => {
    const { configOverrides } = await poolOptionsFor(remote({ apiKey: "sk-test-value" }));
    for (const tier of configOverrides.config) {
      expect(tier.doc).not.toContain("sk-test-value");
    }
  });
});
