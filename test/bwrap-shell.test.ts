import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { shellBaseEnv } from "../src/bwrap/shell.js";

describe("shellBaseEnv", () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("未配置时只有执行层自己的基础值", () => {
    expect(shellBaseEnv()).toEqual({
      HOME: originalHome,
      SHELL: "/bin/bash",
      TERM: "dumb",
      LANG: "C.UTF-8",
      PATH: "/usr/local/bin:/usr/bin:/bin",
    });
  });

  it("shell.env 注入项合并进基础环境，同名变量以配置为准", () => {
    const env = shellBaseEnv({ GIT_EDITOR: "true", LANG: "C" });

    expect(env.GIT_EDITOR).toBe("true");
    expect(env.LANG).toBe("C");
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });

  it("HOME 缺失时明确失败，不在没有家目录的环境里跑 bash", () => {
    delete process.env.HOME;

    expect(() => shellBaseEnv()).toThrow(/HOME is not set/u);
  });
});
