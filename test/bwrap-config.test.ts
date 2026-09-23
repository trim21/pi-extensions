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
    await writeFile(
      global,
      JSON.stringify({
        network: { mode: "allow-all" },
        fs: { extraWritablePaths: ["/cache"] },
      }),
    );
    await writeFile(project, JSON.stringify({ fs: { writablePaths: ["."] } }));

    expect(loadBwrapConfig(directory, { global, project })).toEqual({
      fs: {
        mode: "workspace-write",
        writablePaths: ["."],
        extraWritablePaths: ["/cache"],
        denyPaths: [],
      },
      network: { mode: "allow-all", allowlist: [] },
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

  it("raises for an invalid mode with the field path", async () => {
    const { directory, global, project } = await configPaths();
    await writeFile(global, JSON.stringify({ fs: { mode: "unsafe" } }));

    const load = () => loadBwrapConfig(directory, { global, project });
    expect(load).toThrow(`Invalid bwrap configuration at ${global}`);
    expect(load).toThrow(/\/fs\/mode: /);
  });

  it("raises for an invalid array member with the field path", async () => {
    const { directory, global, project } = await configPaths();
    await writeFile(project, JSON.stringify({ extraArgs: ["--bind", 42] }));

    const load = () => loadBwrapConfig(directory, { global, project });
    expect(load).toThrow(`Invalid bwrap configuration at ${project}`);
    expect(load).toThrow(/\/extraArgs\/1: /);
  });

  it("ignores unknown configuration properties", async () => {
    const { directory, global, project } = await configPaths();
    await writeFile(
      project,
      JSON.stringify({
        network: { mode: "limited", unknowable: { future: 1 } },
        unknowable: { future: 1 },
      }),
    );

    expect(loadBwrapConfig(directory, { global, project })).toEqual({
      fs: {
        mode: "workspace-write",
        writablePaths: [".", "/tmp"],
        extraWritablePaths: [],
        denyPaths: [],
      },
      network: { mode: "limited", allowlist: [] },
      extraArgs: [],
      approvalRules: [],
    });
  });

  it("tolerates unknown fields inside approval rules", async () => {
    const { directory, global, project } = await configPaths();
    await writeFile(
      project,
      JSON.stringify({
        approvalRules: [{ action: "allow", pattern: "git *", description: "git" }],
      }),
    );

    expect(loadBwrapConfig(directory, { global, project })).toMatchObject({
      approvalRules: [{ action: "allow", pattern: "git *" }],
    });
  });
});
