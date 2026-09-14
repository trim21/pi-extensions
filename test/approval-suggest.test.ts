import { describe, expect, it } from "vitest";

import { type BashCommand } from "../src/bwrap/approval-rules.js";
import { commandPattern } from "../src/bwrap/approval-suggest.js";

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

  it("folds the -- separator and subcommand args into the arity prefix", () => {
    // "python": 2 → 命令名 + 第一个参数，`--` 及其后的子命令参数全部被折叠
    expect(
      commandPattern(cmd("python", ["./script/file.py", "--", "some", "sub", "command"])),
    ).toBe("python ./script/file.py *");
  });
});
