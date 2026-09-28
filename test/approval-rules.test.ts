import { describe, expect, it, vi } from "vitest";

import {
  type ApprovalRule,
  type ApprovalRuleSetOptions,
  createApprovalRuleSet,
  matchRule,
  parseBashCommands,
} from "../src/bwrap/approval-rules.js";
import { commandPatternsFor } from "../src/bwrap/approval-suggest.js";

/** 规则集：规则由外部数组持有（追加后 getter 立即看到），建议模式用真实的 BashArity 实现。 */
function ruleSet(
  rules: readonly ApprovalRule[],
  persist: ApprovalRuleSetOptions["persist"] = async () => {},
) {
  return createApprovalRuleSet({
    rules: () => rules,
    suggestPatterns: commandPatternsFor,
    persist,
  });
}

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

describe("createApprovalRuleSet", () => {
  describe("evaluate", () => {
    it("allows a matching rule", async () => {
      expect(
        await ruleSet([{ action: "allow", pattern: "git status *" }]).evaluate("git status"),
      ).toBe("allow");
    });

    it("denies a matching rule", async () => {
      expect(
        await ruleSet([{ action: "deny", pattern: "git push *" }]).evaluate("git push origin main"),
      ).toBe("deny");
    });

    it("returns undefined when no rule matches", async () => {
      expect(
        await ruleSet([{ action: "allow", pattern: "git push *" }]).evaluate("git checkout main"),
      ).toBeUndefined();
    });

    it("applies rules to nested commands in command substitution", async () => {
      expect(
        await ruleSet([{ action: "deny", pattern: "curl *" }]).evaluate(
          "echo $(curl -s https://x)",
        ),
      ).toBe("deny");
    });

    it("applies rules to every command in a chain", async () => {
      const denyPush = ruleSet([{ action: "deny", pattern: "git push *" }]);
      expect(await denyPush.evaluate("git fetch && git push origin main")).toBe("deny");
      expect(await denyPush.evaluate("git fetch && git status")).toBeUndefined();
    });

    it("does not allow a chain when only part of it matches an allow rule", async () => {
      // 只允许了 echo *，mkdir 未命中任何规则，应交给人工审批而非整体放行
      expect(
        await ruleSet([{ action: "allow", pattern: "echo *" }]).evaluate(
          "mkdir -p /tmp/x && echo hi",
        ),
      ).toBeUndefined();
    });

    it("allows a chain when every command matches an allow rule", async () => {
      expect(
        await ruleSet([{ action: "allow", pattern: "echo *" }]).evaluate("echo a && echo b"),
      ).toBe("allow");
    });

    it("denies when any command matches a deny rule even if others allow", async () => {
      expect(
        await ruleSet([
          { action: "allow", pattern: "echo *" },
          { action: "deny", pattern: "git push *" },
        ]).evaluate("echo hi && git push origin main"),
      ).toBe("deny");
    });

    it("does not allow a command with an unallowed nested command", async () => {
      expect(
        await ruleSet([{ action: "allow", pattern: "echo *" }]).evaluate(
          "echo $(curl -s https://x)",
        ),
      ).toBeUndefined();
    });

    it("does not allow echo with an output redirection under an echo * rule", async () => {
      const echoAllow: readonly ApprovalRule[] = [{ action: "allow", pattern: "echo *" }];
      expect(await ruleSet(echoAllow).evaluate("echo '' > file")).toBeUndefined();
      expect(await ruleSet(echoAllow).evaluate("echo hi >> file")).toBeUndefined();
      expect(await ruleSet(echoAllow).evaluate("{ echo hi; } > file")).toBeUndefined();
      expect(await ruleSet(echoAllow).evaluate("( echo hi ) > file")).toBeUndefined();
    });

    it("still allows pipelines when every command matches an allow rule", async () => {
      expect(
        await ruleSet([
          { action: "allow", pattern: "echo *" },
          { action: "allow", pattern: "tail *" },
        ]).evaluate("echo '' | tail -n 5"),
      ).toBe("allow");
    });

    it("still allows fd copies and input redirects under an echo * rule", async () => {
      const echoAllow: readonly ApprovalRule[] = [{ action: "allow", pattern: "echo *" }];
      expect(await ruleSet(echoAllow).evaluate("echo hi 2>&1")).toBe("allow");
      expect(await ruleSet(echoAllow).evaluate("echo hi < /etc/passwd")).toBe("allow");
    });

    it("still denies a redirected command that matches a deny rule", async () => {
      expect(
        await ruleSet([{ action: "deny", pattern: "echo *" }]).evaluate("echo hi > file"),
      ).toBe("deny");
    });

    it("last matching rule wins (later rules take precedence)", async () => {
      expect(
        await ruleSet([
          { action: "deny", pattern: "git push *" },
          { action: "allow", pattern: "git *" },
        ]).evaluate("git push origin main"),
      ).toBe("allow");
    });

    it("lets a later deny rule override an earlier allow rule", async () => {
      expect(
        await ruleSet([
          { action: "allow", pattern: "git *" },
          { action: "deny", pattern: "git push *" },
        ]).evaluate("git push origin main"),
      ).toBe("deny");
    });

    it("allows a script invocation under a rule that lists the -- separator", async () => {
      // 规则匹配的是命令原文，`--` 只是普通字面 token
      expect(
        await ruleSet([{ action: "allow", pattern: "python ./script/file.py -- *" }]).evaluate(
          "python ./script/file.py -- some sub command",
        ),
      ).toBe("allow");
    });

    it("allows a command under a rule that lists a literal flag", async () => {
      expect(
        await ruleSet([{ action: "allow", pattern: "npm install --save-dev *" }]).evaluate(
          "npm install --save-dev vitest",
        ),
      ).toBe("allow");
    });

    it("does not allow a script invocation when the rule requires a different literal", async () => {
      expect(
        await ruleSet([{ action: "allow", pattern: "python ./script/file.py -- *" }]).evaluate(
          "python ./script/file.py other.py",
        ),
      ).toBeUndefined();
    });
  });

  describe("isAllowed", () => {
    it("reports a pattern covered by an allow rule", () => {
      expect(ruleSet([{ action: "allow", pattern: "git *" }]).isAllowed("git status")).toBe(true);
    });

    it("reports a pattern covered by a later deny rule as not allowed", () => {
      const set = ruleSet([
        { action: "allow", pattern: "git push *" },
        { action: "deny", pattern: "git *" },
      ]);
      expect(set.isAllowed("git push origin main")).toBe(false);
    });

    it("reports an uncovered pattern as not allowed", () => {
      expect(ruleSet([{ action: "allow", pattern: "git push *" }]).isAllowed("git status")).toBe(
        false,
      );
    });
  });

  describe("pendingPatterns", () => {
    it("deduplicates the suggested patterns", async () => {
      expect(await ruleSet([]).pendingPatterns("echo a && echo b")).toEqual(["echo *"]);
    });

    it("drops the patterns already covered by an allow rule", async () => {
      const pending = await ruleSet([{ action: "allow", pattern: "echo *" }]).pendingPatterns(
        "echo hi && head -n 1 /dev/null",
      );
      expect(pending).toEqual(["head *"]);
    });

    it("stays consistent with isAllowed for every suggested pattern", async () => {
      const set = ruleSet([{ action: "allow", pattern: "echo *" }]);
      const pending = await set.pendingPatterns("echo hi && head -n 1 /dev/null");
      // 已允许的不出现在待允许列表里，未覆盖的才列出
      expect(pending).toEqual(["head *"]);
      expect(set.isAllowed("echo *")).toBe(true);
      expect(set.isAllowed("head *")).toBe(false);
    });
  });

  describe("addAllowRules", () => {
    it("persists allow rules and makes them effective immediately", async () => {
      const rules: ApprovalRule[] = [];
      const persisted: (readonly ApprovalRule[])[] = [];
      const set = ruleSet(rules, async (newRules) => {
        persisted.push(newRules);
        // 模拟 runtime：持久化成功后规则 getter 立即看到新规则
        rules.push(...newRules);
      });
      await set.addAllowRules(["git status *"]);
      expect(persisted).toEqual([[{ action: "allow", pattern: "git status *" }]]);
      expect(set.isAllowed("git status")).toBe(true);
      expect(await set.evaluate("git status")).toBe("allow");
    });

    it("leaves the rules untouched when persist rejects", async () => {
      const rules: ApprovalRule[] = [];
      const set = ruleSet(rules, async () => {
        throw new Error("cannot write config");
      });
      await expect(set.addAllowRules(["git status *"])).rejects.toThrow("cannot write config");
      expect(rules).toEqual([]);
      expect(set.isAllowed("git status")).toBe(false);
      expect(await set.evaluate("git status")).toBeUndefined();
    });

    it("does not persist anything without patterns", async () => {
      const persist = vi.fn(async () => {});
      await ruleSet([], persist).addAllowRules([]);
      expect(persist).not.toHaveBeenCalled();
    });
  });
});
