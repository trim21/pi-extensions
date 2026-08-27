import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  expandHome,
  formatDisplayPath,
  formatSubtitlePath,
  resolveHomePath,
} from "../src/lib/path.js";

describe("expandHome", () => {
  it("expands ~ and ~/ to the home directory", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/a/b")).toBe(join(homedir(), "a", "b"));
  });

  it("leaves other forms untouched", () => {
    expect(expandHome("/abs")).toBe("/abs");
    expect(expandHome("~user")).toBe("~user");
    expect(expandHome("rel")).toBe("rel");
  });
});

describe("resolveHomePath", () => {
  // `/base` 是 POSIX 根路径语义：Windows 上会解析为当前盘符（D:\base），
  // 这两个用例只跑 Unix。
  it.skipIf(process.platform === "win32")("resolves relative paths against baseDir", () => {
    expect(resolveHomePath("talk.db", "/base")).toBe("/base/talk.db");
    expect(resolveHomePath("./talk.db", "/base")).toBe("/base/talk.db");
    // settings.json lives in ~/.pi/agent, so relative db_path resolves from there
    expect(resolveHomePath("./tmp/chat.db", `${homedir()}/.pi/agent`)).toBe(
      join(homedir(), ".pi", "agent", "tmp", "chat.db"),
    );
  });

  it.skipIf(process.platform === "win32")("keeps absolute paths", () => {
    expect(resolveHomePath("/abs/talk.db", "/base")).toBe("/abs/talk.db");
  });

  it("expands ~ before resolving", () => {
    expect(resolveHomePath("~/talk.db", "/base")).toBe(join(homedir(), "talk.db"));
  });
});

describe("formatDisplayPath", () => {
  const cwd = resolve("/work", "project");

  // 显示路径用 path.relative 生成，Windows 上分隔符是 \，断言按 POSIX 风格写的
  it.skipIf(process.platform === "win32")("uses ./… for paths inside cwd", () => {
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

  it("appends LSP error count when provided", () => {
    expect(formatSubtitlePath(cwd, resolve(cwd, "src/app.ts"), 3)).toBe("./src/app.ts (ⓧ 3)");
    expect(formatSubtitlePath(cwd, resolve(cwd, "src/app.ts"), 1)).toBe("./src/app.ts (ⓧ 1)");
  });

  it("omits the error count when zero or absent", () => {
    expect(formatSubtitlePath(cwd, resolve(cwd, "src/app.ts"), 0)).toBe("./src/app.ts");
    expect(formatSubtitlePath(cwd, resolve(cwd, "src/app.ts"))).toBe("./src/app.ts");
  });
});
