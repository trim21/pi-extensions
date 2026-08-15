import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadBwrapConfig } from "../src/bwrap/core.js";

async function configPaths() {
  const directory = await mkdtemp(join(tmpdir(), "bwrap-config-"));
  const global = join(directory, "global.json");
  const project = join(directory, "project.json");
  return { directory, global, project };
}

describe("loadBwrapConfig", () => {
  it("validates file overrides before merging defaults", async () => {
    const { directory, global, project } = await configPaths();
    await writeFile(global, JSON.stringify({ mode: "allow-net", extraWritablePaths: ["/cache"] }));
    await writeFile(project, JSON.stringify({ writablePaths: ["."] }));

    expect(loadBwrapConfig(directory, { global, project })).toEqual({
      mode: "allow-net",
      writablePaths: ["."],
      extraWritablePaths: ["/cache"],
      tmpfsPaths: [],
      extraArgs: [],
      approvalRules: [],
    });
  });

  it("raises for malformed JSON", async () => {
    const { directory, global, project } = await configPaths();
    await writeFile(global, "{");

    expect(() => loadBwrapConfig(directory, { global, project })).toThrow(
      `Invalid bwrap configuration at ${global}`,
    );
  });

  it("raises for an invalid mode", async () => {
    const { directory, global, project } = await configPaths();
    await writeFile(global, JSON.stringify({ mode: "unsafe" }));

    expect(() => loadBwrapConfig(directory, { global, project })).toThrow(
      `Invalid bwrap configuration at ${global}`,
    );
  });

  it("raises for an invalid array member", async () => {
    const { directory, global, project } = await configPaths();
    await writeFile(project, JSON.stringify({ extraArgs: ["--bind", 42] }));

    expect(() => loadBwrapConfig(directory, { global, project })).toThrow(
      `Invalid bwrap configuration at ${project}`,
    );
  });

  it("raises for an unknown configuration property", async () => {
    const { directory, global, project } = await configPaths();
    await writeFile(project, JSON.stringify({ unknowable: true }));

    expect(() => loadBwrapConfig(directory, { global, project })).toThrow(
      `Invalid bwrap configuration at ${project}`,
    );
  });
});
