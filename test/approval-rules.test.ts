import { describe, expect, it } from "vitest";

import {
  type BashCommand,
  commandPattern,
  evaluateBashApproval,
  matchRule,
  parseBashCommands,
} from "../src/bwrap/approval-rules.js";

describe("parseBashCommands", () => {
  it("extracts top-level commands with name and args", async () => {
    const parsed = await parseBashCommands("git checkout main && npm install");
    expect(parsed.error).toBeUndefined();
    expect(parsed.commands.map((c) => c.name)).toEqual(["git", "npm"]);
    expect(parsed.commands[0].args).toEqual(["checkout", "main"]);
    expect(parsed.commands[0].nested).toEqual([]);
  });

  it("extracts commands from both sides of a pipeline", async () => {
    const parsed = await parseBashCommands("git log | head -20");
    expect(parsed.commands.map((c) => c.name)).toEqual(["git", "head"]);
  });

  it("extracts nested commands from command substitution", async () => {
    const parsed = await parseBashCommands("echo $(curl -s https://x)");
    const echo = parsed.commands.find((c) => c.name === "echo")!;
    expect(echo).toBeDefined();
    expect(echo.nested.map((n) => n.name)).toEqual(["curl"]);
    expect(echo.nested[0].args).toEqual(["-s", "https://x"]);
  });

  it("tolerates malformed input: tree-sitter is error-tolerant, no throw", async () => {
    const parsed = await parseBashCommands('echo "${unclosed');
    // tree-sitter 容错：不完整语法仍能提取已解析的命令，且不抛错
    expect(parsed.commands.map((c) => c.name)).toContain("echo");
  });

  it("handles redirects and quoted args", async () => {
    const parsed = await parseBashCommands('echo "hello world" > /tmp/out');
    const echo = parsed.commands.find((c) => c.name === "echo")!;
    expect(echo.args).toEqual(['"hello world"']);
  });
});

const cmd = (name: string, args: string[]): BashCommand => ({ name, args, raw: "", nested: [] });

describe("commandPattern", () => {
  it("uses BashArity to keep subcommands, dropping flags and values", () => {
    expect(commandPattern(cmd("git", ["checkout", "main"]))).toBe("git checkout *");
    expect(commandPattern(cmd("git", ["push", "origin", "main"]))).toBe("git push *");
    expect(commandPattern(cmd("npm", ["install", "react"]))).toBe("npm install *");
    expect(commandPattern(cmd("npm", ["run", "dev"]))).toBe("npm run dev *");
  });

  it("falls back to command name + * for unknown commands", () => {
    expect(commandPattern(cmd("some-tool", ["--flag", "value"]))).toBe("some-tool *");
  });
});

describe("matchRule", () => {
  it("matches wildcards", () => {
    expect(matchRule("git push *", "git push *")).toBe(true);
    expect(matchRule("git push *", "git *")).toBe(true);
    expect(matchRule("git checkout *", "git push *")).toBe(false);
    expect(matchRule("npm install *", "npm *")).toBe(true);
  });
});

describe("evaluateBashApproval", () => {
  it("allows a matching rule", async () => {
    expect(
      await evaluateBashApproval("git status", [{ action: "allow", pattern: "git status *" }]),
    ).toBe("allow");
  });

  it("denies a matching rule", async () => {
    expect(
      await evaluateBashApproval("git push origin main", [
        { action: "deny", pattern: "git push *" },
      ]),
    ).toBe("deny");
  });

  it("returns undefined when no rule matches", async () => {
    expect(
      await evaluateBashApproval("git checkout main", [{ action: "allow", pattern: "git push *" }]),
    ).toBeUndefined();
  });

  it("applies rules to nested commands in command substitution", async () => {
    expect(
      await evaluateBashApproval("echo $(curl -s https://x)", [
        { action: "deny", pattern: "curl *" },
      ]),
    ).toBe("deny");
  });

  it("applies rules to every command in a chain", async () => {
    expect(
      await evaluateBashApproval("git fetch && git push origin main", [
        { action: "deny", pattern: "git push *" },
      ]),
    ).toBe("deny");
    expect(
      await evaluateBashApproval("git fetch && git status", [
        { action: "deny", pattern: "git push *" },
      ]),
    ).toBeUndefined();
  });

  it("does not allow a chain when only part of it matches an allow rule", async () => {
    // 只允许了 echo *，mkdir 未命中任何规则，应交给人工审批而非整体放行
    expect(
      await evaluateBashApproval("mkdir -p /tmp/x && echo hi", [
        { action: "allow", pattern: "echo *" },
      ]),
    ).toBeUndefined();
  });

  it("allows a chain when every command matches an allow rule", async () => {
    expect(
      await evaluateBashApproval("echo a && echo b", [{ action: "allow", pattern: "echo *" }]),
    ).toBe("allow");
  });

  it("denies when any command matches a deny rule even if others allow", async () => {
    expect(
      await evaluateBashApproval("echo hi && git push origin main", [
        { action: "allow", pattern: "echo *" },
        { action: "deny", pattern: "git push *" },
      ]),
    ).toBe("deny");
  });

  it("does not allow a command with an unallowed nested command", async () => {
    expect(
      await evaluateBashApproval("echo $(curl -s https://x)", [
        { action: "allow", pattern: "echo *" },
      ]),
    ).toBeUndefined();
  });

  it("last matching rule wins (later rules take precedence)", async () => {
    // 命令模式是 arity 粒度（git push *），规则需按同粒度写
    expect(
      await evaluateBashApproval("git push origin main", [
        { action: "deny", pattern: "git push *" },
        { action: "allow", pattern: "git *" },
      ]),
    ).toBe("allow");
  });
});
