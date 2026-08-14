/**
 * Tests for the bash-default-timeout extension:
 * - sets a 180s (180000ms) timeout on bash tool calls that do not declare one
 * - leaves existing timeouts and non-bash calls untouched
 */
import { describe, expect, it } from "vitest";

import bashDefaultTimeout from "../src/bash-default-timeout.js";

interface ToolCallLike {
  toolName: string;
  input: Record<string, unknown>;
}

function loadHandler(): (event: ToolCallLike) => void {
  let handler: ((event: ToolCallLike) => void) | undefined;
  bashDefaultTimeout({
    on: (event: string, h: unknown) => {
      if (event === "tool_call") handler = h as never;
    },
  } as never);
  if (!handler) throw new Error("tool_call handler not registered");
  return handler;
}

describe("bash-default-timeout", () => {
  it("sets a 180s timeout on bash calls without one", () => {
    const handler = loadHandler();
    const event: ToolCallLike = { toolName: "bash", input: {} };
    handler(event);
    expect(event.input.timeout).toBe(180_000);
  });

  it("leaves an existing timeout untouched", () => {
    const handler = loadHandler();
    const event: ToolCallLike = { toolName: "bash", input: { timeout: 60_000 } };
    handler(event);
    expect(event.input.timeout).toBe(60_000);
  });

  it("ignores non-bash tool calls", () => {
    const handler = loadHandler();
    const event: ToolCallLike = { toolName: "read", input: {} };
    handler(event);
    expect(event.input.timeout).toBeUndefined();
  });
});
