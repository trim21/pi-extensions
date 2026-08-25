import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildOutlineSubtitle,
  buildZoomSubtitle,
  formatSubtitlePath,
  resolvePathArg,
} from "../src/aft/tools.js";
import { formatDisplayPath } from "../src/lib/path.js";

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

describe("buildZoomSubtitle", () => {
  const cwd = resolve("/work", "project");

  it.skipIf(process.platform === "win32")("formats path + single symbol", () => {
    expect(buildZoomSubtitle(cwd, { path: "./src/app.ts", symbols: "main" })).toBe(
      'path="./src/app.ts" symbol="main"',
    );
  });

  it.skipIf(process.platform === "win32")("joins multiple symbols with comma", () => {
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

  it.skipIf(process.platform === "win32")("omits symbol when absent", () => {
    expect(buildZoomSubtitle(cwd, { path: "./src/app.ts" })).toBe('path="./src/app.ts"');
  });
});

describe("formatSubtitlePath", () => {
  const cwd = resolve("/work", "project");

  it.skipIf(process.platform === "win32")("uses ./… for short paths inside cwd", () => {
    expect(formatSubtitlePath(cwd, resolve(cwd, "src/app.ts"))).toBe("./src/app.ts");
  });

  it("uses ~/… for short paths inside home", () => {
    const homePath = join(homedir(), "config", "app.json");
    expect(formatSubtitlePath(cwd, homePath)).toBe(`~/${join("config", "app.json")}`);
  });

  it("keeps short absolute paths outside cwd and home", () => {
    expect(formatSubtitlePath(cwd, "/etc/passwd")).toBe("/etc/passwd");
  });

  it("falls back to basename when the display path is too long", () => {
    const longPath = resolve(
      cwd,
      "src/components/very-long-directory-name-here/deeper/another-long-name/App.module.spec.test.ts",
    );
    expect(formatDisplayPath(cwd, longPath).length).toBeGreaterThan(60);
    expect(formatSubtitlePath(cwd, longPath)).toBe("App.module.spec.test.ts");
  });
});

describe("buildOutlineSubtitle", () => {
  const cwd = resolve("/work", "project");

  it.skipIf(process.platform === "win32")("formats target path", () => {
    expect(buildOutlineSubtitle(cwd, "./src/app.ts")).toBe('target="./src/app.ts"');
  });

  it.skipIf(process.platform === "win32")("falls back to basename for long targets", () => {
    const longPath = resolve(
      cwd,
      "src/components/very-long-directory-name-here/deeper/another-long-name/App.module.spec.test.ts",
    );
    expect(buildOutlineSubtitle(cwd, longPath)).toBe('target="App.module.spec.test.ts"');
  });
});
