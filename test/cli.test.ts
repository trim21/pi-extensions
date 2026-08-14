/**
 * Tests for the declarative CLI parser (src/lib/cli.ts).
 */
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { parseCommand } from "../src/lib/cli.js";

const spec = {
  name: "talk-group-join",
  usage: "[group name] [options]",
  description: "Join or create a private agent group.",
  flags: Type.Object({
    name: Type.Optional(Type.String({ description: "Set this agent's display name" })),
    all: Type.Optional(Type.Boolean()),
    count: Type.Optional(Type.Number()),
    mode: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("slow")])),
    level: Type.Integer({ default: 1 }),
  }),
  flagMeta: { name: { short: "n", valuePlaceholder: "<alias>" }, all: { short: "a" } },
  arity: { max: 1 },
  examples: ["/talk-group-join frontend"],
};

describe("parseCommand", () => {
  it("parses positionals and long flags", () => {
    const r = parseCommand(spec, "frontend --name web");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.args).toEqual(["frontend"]);
    expect(r.flags.name).toBe("web");
  });

  it("supports --flag=value", () => {
    const r = parseCommand(spec, "--name=web");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.flags.name).toBe("web");
  });

  it("supports short flags: -n value, -n=value, -nvalue", () => {
    for (const input of ["-n web", "-n=web", "-nweb"]) {
      const r = parseCommand(spec, input);
      expect(r.kind).toBe("ok");
      if (r.kind !== "ok") return;
      expect(r.flags.name).toBe("web");
    }
  });

  it("combines short boolean flags and switches to a value flag", () => {
    const r = parseCommand(spec, "-an web");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.flags.all).toBe(true);
    expect(r.flags.name).toBe("web");
  });

  it("coerces number values, including negatives", () => {
    const r = parseCommand(spec, "--count 3");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.flags.count).toBe(3);

    const neg = parseCommand(spec, "--count -5");
    expect(neg.kind).toBe("ok");
    if (neg.kind !== "ok") return;
    expect(neg.flags.count).toBe(-5);
  });

  it("applies defaults and leaves optional flags unset", () => {
    const r = parseCommand(spec, "");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.flags.level).toBe(1);
    expect(r.flags.name).toBeUndefined();
  });

  it("treats everything after -- as positional", () => {
    const r = parseCommand(spec, "-- --name");
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.args).toEqual(["--name"]);
    expect(r.flags.name).toBeUndefined();
  });

  it("returns rendered help for -h and --help", () => {
    for (const input of ["-h", "--help"]) {
      const r = parseCommand(spec, input);
      expect(r.kind).toBe("help");
      if (r.kind !== "help") return;
      expect(r.text).toContain("Usage: /talk-group-join [group name] [options]");
      expect(r.text).toContain("Join or create a private agent group.");
      expect(r.text).toContain("-n, --name <alias>");
      expect(r.text).toContain("Display this message");
      expect(r.text).toContain("/talk-group-join frontend");
    }
  });

  it("lets help win over a missing value", () => {
    for (const input of ["--name --help", "-n -h"]) {
      const r = parseCommand(spec, input);
      expect(r.kind).toBe("help");
    }
  });

  it("reports unknown long and short options", () => {
    const long = parseCommand(spec, "--bogus");
    expect(long.kind).toBe("error");
    if (long.kind !== "error") return;
    expect(long.text).toContain("Unknown option '--bogus'");
    expect(long.text).toContain("Try '/talk-group-join --help' for usage.");

    const short = parseCommand(spec, "-z");
    expect(short.kind).toBe("error");
    if (short.kind !== "error") return;
    expect(short.text).toContain("Unknown option '-z'");
  });

  it("reports a missing value", () => {
    const r = parseCommand(spec, "--name");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.text).toContain("Option '--name' requires a value");
  });

  it("reports a missing required argument", () => {
    const del = {
      name: "talk-group-del",
      usage: "<group name>",
      flags: Type.Object({}),
      arity: { min: 1, max: 1 },
    };
    const r = parseCommand(del, "");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.text).toContain("Missing required argument");
  });

  it("reports too many arguments", () => {
    const r = parseCommand(spec, "a b");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.text).toContain("Too many arguments");
  });

  it("rejects invalid enum values", () => {
    const r = parseCommand(spec, "--mode zzz");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.text).toContain("expected one of: fast, slow");
  });

  it("rejects invalid numbers", () => {
    const r = parseCommand(spec, "--count abc");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.text).toContain("Invalid value for '--count'");
  });

  it("reports a missing required option", () => {
    const req = { name: "x", usage: "", flags: Type.Object({ out: Type.String() }) };
    const r = parseCommand(req, "");
    expect(r.kind).toBe("error");
    if (r.kind !== "error") return;
    expect(r.text).toContain("Missing required option '--out'");
  });
});
