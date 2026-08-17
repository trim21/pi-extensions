import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePathArg } from "../src/aft/tools.js";

describe("resolvePathArg", () => {
  const cwd = resolve("/work", "project");

  it("resolves relative paths against cwd", () => {
    expect(resolvePathArg(cwd, "src/app.ts")).toBe(resolve(cwd, "src/app.ts"));
    expect(resolvePathArg(cwd, "./src/app.ts")).toBe(resolve(cwd, "./src/app.ts"));
    expect(resolvePathArg(cwd, "../other/a.ts")).toBe(resolve(cwd, "../other/a.ts"));
  });

  it("keeps absolute paths unchanged", () => {
    expect(resolvePathArg(cwd, "/abs/path.ts")).toBe("/abs/path.ts");
  });

  it("expands ~ and ~/ prefixes to home", () => {
    expect(resolvePathArg(cwd, "~/config.json")).toBe(join(homedir(), "config.json"));
    expect(resolvePathArg(cwd, "~")).toBe(homedir());
  });

  it("keeps URLs unchanged", () => {
    expect(resolvePathArg(cwd, "https://example.com/a.md")).toBe("https://example.com/a.md");
  });
});
