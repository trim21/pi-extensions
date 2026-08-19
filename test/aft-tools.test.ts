import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { buildZoomSubtitle, formatDisplayPath, resolvePathArg } from "../src/aft/tools.js";

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

describe("formatDisplayPath", () => {
  const cwd = resolve("/work", "project");

  it("uses ./… for paths inside cwd", () => {
    expect(formatDisplayPath(cwd, resolve(cwd, "src/app.ts"))).toBe("./src/app.ts");
  });

  it("uses ~/… for paths inside home but outside cwd", () => {
    const homePath = join(homedir(), "config", "app.json");
    expect(formatDisplayPath(cwd, homePath)).toBe(`~/${join("config", "app.json")}`);
  });

  it("keeps absolute paths outside cwd and home", () => {
    expect(formatDisplayPath(cwd, "/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("buildZoomSubtitle", () => {
  const cwd = resolve("/work", "project");

  it("formats path + single symbol", () => {
    expect(buildZoomSubtitle(cwd, { path: "./src/app.ts", symbols: "main" })).toBe(
      'path="./src/app.ts" symbol="main"',
    );
  });

  it("joins multiple symbols with comma", () => {
    expect(buildZoomSubtitle(cwd, { path: "src/app.ts", symbols: ["a", "b"] })).toBe(
      'path="./src/app.ts" symbol="a, b"',
    );
  });

  it("formats home paths as ~/…", () => {
    expect(buildZoomSubtitle(cwd, { path: "~/config.ts", symbols: "cfg" })).toBe(
      'path="~/config.ts" symbol="cfg"',
    );
  });

  it("keeps absolute paths outside cwd and home", () => {
    expect(buildZoomSubtitle(cwd, { path: "/etc/x.ts", symbols: "s" })).toBe(
      'path="/etc/x.ts" symbol="s"',
    );
  });

  it("omits symbol when absent", () => {
    expect(buildZoomSubtitle(cwd, { path: "./src/app.ts" })).toBe('path="./src/app.ts"');
  });

  it("handles a single targets object", () => {
    expect(buildZoomSubtitle(cwd, { targets: { path: "./a.ts", symbol: "x" } })).toBe(
      'path="./a.ts" symbol="x"',
    );
  });

  it("joins multiple targets", () => {
    expect(
      buildZoomSubtitle(cwd, {
        targets: [
          { path: "./a.ts", symbol: "x" },
          { path: "./b.ts", symbol: "y" },
        ],
      }),
    ).toBe('path="./a.ts" symbol="x" path="./b.ts" symbol="y"');
  });

  it("formats url mode", () => {
    expect(buildZoomSubtitle(cwd, { url: "https://example.com/a.md", symbols: "Intro" })).toBe(
      'url="https://example.com/a.md"',
    );
  });

  it("returns undefined for empty params", () => {
    expect(buildZoomSubtitle(cwd, {})).toBeUndefined();
  });
});
