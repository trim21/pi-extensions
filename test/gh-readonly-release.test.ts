/**
 * Tests for the release asset download helpers in `src/gh-readonly.ts`:
 * the cache directory a release maps to, the `pattern` parameter splitting, and
 * the `gh release download` argv. The `gh` invocation itself is the backend and
 * is not stubbed here.
 */
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  downloadReleaseAssets,
  releaseAssetDir,
  releaseDownloadArgs,
  releasePatterns,
} from "../src/gh-readonly.js";

describe("releaseAssetDir", () => {
  it("keys the cache on owner, repo and tag", () => {
    expect(releaseAssetDir("cli/cli", "v2.100.0")).toBe(
      join(homedir(), ".cache", "pi", "github", "releases", "cli", "cli", "v2.100.0"),
    );
  });

  // A tag is a git ref name and may contain `/`; it must never escape its own
  // directory (and `..` is the one legal-looking segment that would).
  it("flattens every character that is not safe in one path segment", () => {
    expect(releaseAssetDir("a/b", "release/1.0")).toBe(
      join(homedir(), ".cache", "pi", "github", "releases", "a", "b", "release_1.0"),
    );
    expect(releaseAssetDir("a/b", "..")).toBe(
      join(homedir(), ".cache", "pi", "github", "releases", "a", "b", "_"),
    );
  });

  it("rejects a repo string that is not OWNER/REPO", () => {
    expect(() => releaseAssetDir("nope", "v1")).toThrow("invalid repository");
  });
});

describe("releasePatterns", () => {
  it("returns nothing when the parameter is absent", () => {
    expect(releasePatterns(undefined)).toEqual([]);
  });

  it("splits on commas and drops blanks", () => {
    expect(releasePatterns(" *.tar.gz,, *.deb ,")).toEqual(["*.tar.gz", "*.deb"]);
  });
});

describe("releaseDownloadArgs", () => {
  const base = { tag: "v1.2.3", repo: "cli/cli", dir: "/tmp/rel" };

  it("downloads every asset and never overwrites what is cached", () => {
    expect(releaseDownloadArgs({ ...base, patterns: [] })).toEqual([
      "release",
      "download",
      "v1.2.3",
      "--repo",
      "cli/cli",
      "--dir",
      "/tmp/rel",
      "--skip-existing",
    ]);
  });

  it("passes each pattern as its own flag", () => {
    expect(releaseDownloadArgs({ ...base, patterns: ["*.deb", "*.rpm"] })).toEqual([
      "release",
      "download",
      "v1.2.3",
      "--repo",
      "cli/cli",
      "--pattern",
      "*.deb",
      "--pattern",
      "*.rpm",
      "--dir",
      "/tmp/rel",
      "--skip-existing",
    ]);
  });

  it("switches to the source archive when asked", () => {
    expect(releaseDownloadArgs({ ...base, patterns: [], archive: "tar.gz" })).toEqual([
      "release",
      "download",
      "v1.2.3",
      "--repo",
      "cli/cli",
      "--archive",
      "tar.gz",
      "--dir",
      "/tmp/rel",
      "--skip-existing",
    ]);
  });
});

describe("downloadReleaseAssets validation", () => {
  it("refuses to combine asset patterns with the source archive", async () => {
    await expect(
      downloadReleaseAssets({
        params: { pattern: "*.deb", archive: "zip" },
        ctx: {},
      }),
    ).rejects.toThrow("mutually exclusive");
  });
});
