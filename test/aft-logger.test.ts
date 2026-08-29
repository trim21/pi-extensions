import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAftLogger } from "../src/aft/logger.js";

describe("aft logger session-scoped path", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "aft-logger-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("puts the log under tmp/{sessionId} when a session id is given", () => {
    const logger = createAftLogger("session-a");
    expect(logger.getLogFilePath()).toBe(join(agentDir, "tmp", "session-a", "aft-plugin.log"));
  });

  it("falls back to tmp/aft-plugin.log without a session id", () => {
    const logger = createAftLogger();
    expect(logger.getLogFilePath()).toBe(join(agentDir, "tmp", "aft-plugin.log"));
  });

  it("writes buffered messages into the session-scoped file", async () => {
    const logger = createAftLogger("session-a");
    logger.log("hello from aft");
    await logger.drain();
    const content = readFileSync(join(agentDir, "tmp", "session-a", "aft-plugin.log"), "utf8");
    expect(content).toContain("hello from aft");
    expect(content).toContain("[aft-pi]");
  });
});
