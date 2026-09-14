import { describe, expect, it } from "vitest";

import { evaluateBashApproval, matchRule, parseBashCommands } from "../src/bwrap/approval-rules.js";

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
    expect(parsed.hasFileOutputRedirect).toBe(true);
  });

  it("does not treat pipelines or fd copies as file output redirects", async () => {
    expect((await parseBashCommands("echo hi | tail -n 5")).hasFileOutputRedirect).toBe(false);
    expect((await parseBashCommands("echo hi 2>&1")).hasFileOutputRedirect).toBe(false);
    expect((await parseBashCommands("echo hi < /etc/passwd")).hasFileOutputRedirect).toBe(false);
  });
});

describe("matchRule", () => {
  it("matches wildcards", () => {
    expect(matchRule("git push *", "git push *")).toBe(true);
    expect(matchRule("git push *", "git *")).toBe(true);
    expect(matchRule("git checkout *", "git push *")).toBe(false);
    expect(matchRule("npm install *", "npm *")).toBe(true);
  });

  it("matches raw commands against a -- separated rule pattern", () => {
    expect(
      matchRule("python ./script/file.py -- some sub command", "python ./script/file.py -- *"),
    ).toBe(true);
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

  it("does not allow echo with an output redirection under an echo * rule", async () => {
    const echoAllow = [{ action: "allow" as const, pattern: "echo *" }];
    expect(await evaluateBashApproval("echo '' > file", echoAllow)).toBeUndefined();
    expect(await evaluateBashApproval("echo hi >> file", echoAllow)).toBeUndefined();
    expect(await evaluateBashApproval("{ echo hi; } > file", echoAllow)).toBeUndefined();
    expect(await evaluateBashApproval("( echo hi ) > file", echoAllow)).toBeUndefined();
  });

  it("still allows pipelines when every command matches an allow rule", async () => {
    expect(
      await evaluateBashApproval("echo '' | tail -n 5", [
        { action: "allow", pattern: "echo *" },
        { action: "allow", pattern: "tail *" },
      ]),
    ).toBe("allow");
  });

  it("still allows fd copies and input redirects under an echo * rule", async () => {
    expect(
      await evaluateBashApproval("echo hi 2>&1", [{ action: "allow", pattern: "echo *" }]),
    ).toBe("allow");
    expect(
      await evaluateBashApproval("echo hi < /etc/passwd", [{ action: "allow", pattern: "echo *" }]),
    ).toBe("allow");
  });

  it("still denies a redirected command that matches a deny rule", async () => {
    expect(
      await evaluateBashApproval("echo hi > file", [{ action: "deny", pattern: "echo *" }]),
    ).toBe("deny");
  });

  it("last matching rule wins (later rules take precedence)", async () => {
    expect(
      await evaluateBashApproval("git push origin main", [
        { action: "deny", pattern: "git push *" },
        { action: "allow", pattern: "git *" },
      ]),
    ).toBe("allow");
  });

  it("allows a script invocation under a rule that lists the -- separator", async () => {
    // 规则匹配的是命令原文，`--` 只是普通字面 token
    expect(
      await evaluateBashApproval("python ./script/file.py -- some sub command", [
        { action: "allow", pattern: "python ./script/file.py -- *" },
      ]),
    ).toBe("allow");
  });

  it("allows a command under a rule that lists a literal flag", async () => {
    expect(
      await evaluateBashApproval("npm install --save-dev vitest", [
        { action: "allow", pattern: "npm install --save-dev *" },
      ]),
    ).toBe("allow");
  });

  it("does not allow a script invocation when the rule requires a different literal", async () => {
    expect(
      await evaluateBashApproval("python ./script/file.py other.py", [
        { action: "allow", pattern: "python ./script/file.py -- *" },
      ]),
    ).toBeUndefined();
  });
});
