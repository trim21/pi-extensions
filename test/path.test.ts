import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { expandHome, resolveHomePath } from "../src/lib/path.js";

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
  it("resolves relative paths against baseDir", () => {
    expect(resolveHomePath("talk.db", "/base")).toBe("/base/talk.db");
    expect(resolveHomePath("./talk.db", "/base")).toBe("/base/talk.db");
    // settings.json lives in ~/.pi/agent, so relative db_path resolves from there
    expect(resolveHomePath("./tmp/chat.db", `${homedir()}/.pi/agent`)).toBe(
      join(homedir(), ".pi", "agent", "tmp", "chat.db"),
    );
  });

  it("keeps absolute paths", () => {
    expect(resolveHomePath("/abs/talk.db", "/base")).toBe("/abs/talk.db");
  });

  it("expands ~ before resolving", () => {
    expect(resolveHomePath("~/talk.db", "/base")).toBe(join(homedir(), "talk.db"));
  });
});
