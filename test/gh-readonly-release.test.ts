/**
 * Tests for the release asset download helpers: 缓存目录、`pattern` 拆分与 glob 匹配、
 * 「同名且大小一致就跳过」（`gh release download --skip-existing` 的替代）与源码归档。
 * 下载本身走 octokit 的读取层，这里用桩替掉（真实端点由 cassette 在别处覆盖）。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GhClient } from "../src/gh/base.js";
import {
  downloadReleaseAssets,
  matchAsset,
  releaseAssetDir,
  releasePatterns,
} from "../src/gh/index.js";

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

describe("matchAsset", () => {
  it("matches every asset when no pattern is given", () => {
    expect(matchAsset("anything.bin", [])).toBe(true);
  });

  it("matches globs, not prefixes", () => {
    expect(matchAsset("cli_2.100.0_linux_amd64.tar.gz", ["*.tar.gz"])).toBe(true);
    expect(matchAsset("cli_2.100.0_linux_amd64.deb", ["*.tar.gz"])).toBe(false);
    expect(matchAsset("cli_2.100.0_linux_amd64.deb", ["*.deb", "*.rpm"])).toBe(true);
    expect(matchAsset("checksums.txt", ["checksums.?xt"])).toBe(true);
  });
});

/** 假 GhClient：只实现 download 需要的 reads 方法。 */
function stubGh(options: {
  assets: { id: number; name: string; size: number }[];
  onAsset?: (name: string) => void;
}) {
  return {
    reads: {
      release: vi.fn(async (_owner: string, _repo: string, tag = "v1.2.3") => ({
        tag_name: tag,
        assets: options.assets,
      })),
      downloadAssetTo: vi.fn(
        async (_owner: string, _repo: string, _id: number, destPath: string) => {
          const name = destPath.split("/").pop() ?? "";
          options.onAsset?.(name);
          await writeFile(destPath, "downloaded");
        },
      ),
      downloadArchiveTo: vi.fn(
        async (_o: string, _r: string, _f: string, _ref: string, destPath: string) => {
          await writeFile(destPath, "archive");
        },
      ),
    },
  } as unknown as GhClient;
}

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("downloadReleaseAssets", () => {
  it("refuses to combine asset patterns with the source archive", async () => {
    await expect(
      downloadReleaseAssets(stubGh({ assets: [] }), {
        params: { pattern: "*.deb", archive: "zip" },
        ctx: {},
      }),
    ).rejects.toThrow("mutually exclusive");
  });

  it("downloads only the assets the globs select", async () => {
    const downloaded: string[] = [];
    const gh = stubGh({
      assets: [
        { id: 1, name: "cli_1.0_linux_amd64.tar.gz", size: 10 },
        { id: 2, name: "cli_1.0_linux_amd64.deb", size: 20 },
        { id: 3, name: "checksums.txt", size: 5 },
      ],
      onAsset: (name) => {
        downloaded.push(name);
      },
    });

    // 缓存目录固定在 homedir 下，测试用临时 home 不现实；这里只断言「选中的资产被下载」
    await downloadReleaseAssets(gh, {
      params: { repo: "cli/cli", tag: "v1.2.3", pattern: "*.deb,checksums.txt" },
      ctx: {},
    });

    expect(downloaded).toEqual(["cli_1.0_linux_amd64.deb", "checksums.txt"]);
  });

  it("skips an asset whose file is already there with the same size", async () => {
    // 缓存目录固定在 homedir 下：用一个一次性的 tag，避免碰真实缓存
    const tag = `v0.0.0-test-${process.pid}-${Math.random().toString(36).slice(2)}`;
    const dir = releaseAssetDir("cli/cli", tag);
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "checksums.txt"), "12345");

    const gh = stubGh({ assets: [{ id: 1, name: "checksums.txt", size: 5 }] });

    const result = await downloadReleaseAssets(gh, {
      params: { repo: "cli/cli", tag, pattern: "checksums.txt" },
      ctx: {},
    });

    // 大小一致 → 不重新下载；目录里那份仍然是原文件
    expect(
      (gh.reads as unknown as { downloadAssetTo: { mock: { calls: unknown[][] } } })
        .downloadAssetTo,
    ).not.toHaveBeenCalled();
    expect(result.structuredResult).toMatchObject({
      ok: true,
      value: { files: [{ name: "checksums.txt", bytes: 5 }] },
    });
  });

  it("names the source archive after the repo and tag", async () => {
    const gh = stubGh({ assets: [] });

    await downloadReleaseAssets(gh, {
      params: { repo: "cli/cli", tag: "v1.2.3", archive: "tar.gz" },
      ctx: {},
    });

    const call = (
      gh.reads as unknown as {
        downloadArchiveTo: { mock: { calls: unknown[][] } };
      }
    ).downloadArchiveTo.mock.calls[0];
    expect(call.slice(0, 4)).toEqual(["cli", "cli", "tar.gz", "v1.2.3"]);
    expect(String(call[4]).endsWith("cli-v1.2.3.tar.gz")).toBe(true);
  });

  it("reports the release's assets when a pattern matches nothing", async () => {
    const gh = stubGh({ assets: [{ id: 1, name: "checksums.txt", size: 5 }] });

    await expect(
      downloadReleaseAssets(gh, {
        params: { repo: "cli/cli", tag: "v1.2.3", pattern: "*.deb" },
        ctx: {},
      }),
    ).rejects.toThrow("the release has: checksums.txt");
  });
});
