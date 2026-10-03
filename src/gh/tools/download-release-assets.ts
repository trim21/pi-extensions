import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, matchesGlob } from "node:path";

import { Type } from "typebox";
import { Value } from "typebox/value";

import { type ToolPendant } from "../../lib/pendant.js";
import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  resolveRepoTarget,
  splitRepo,
  structuredFailure,
  type StructuredFailureResult,
  type StructuredResultOf,
  subtitlePendant,
  type ToolCall,
  withStructuredResult,
} from "../base.js";
import { releaseDownloadSchema } from "../schemas.js";

interface ReleaseDownloadParams {
  repo?: string;
  tag?: string;
  pattern?: string;
  archive?: "zip" | "tar.gz";
}

/** `repos.getReleaseByTag` / `getLatestRelease` 里本工具真正读取的字段。 */
const releaseViewSchema = Type.Object({
  tag_name: Type.String(),
  assets: Type.Array(Type.Object({ id: Type.Number(), name: Type.String(), size: Type.Number() })),
});

/** One regular file in a release's download directory. */
interface ReleaseFile {
  name: string;
  path: string;
  bytes: number;
}

/**
 * Directory the release assets of one release are downloaded into:
 * `~/.cache/pi/github/releases/<owner>/<repo>/<tag>/`.
 *
 * A tag is a git ref name and may contain `/`; only the characters that are safe
 * in one path segment survive, so a tag can never escape its own directory.
 */
export function releaseAssetDir(repo: string, tag: string): string {
  const { owner, repo: name } = splitRepo(repo);
  const safeTag = tag.replaceAll(/[^A-Za-z0-9._+-]/g, "_").replace(/^\.+$/, "_");
  return join(homedir(), ".cache", "pi", "github", "releases", owner, name, safeTag);
}

/** Split the comma-separated `pattern` toolcall parameter into glob values. */
export function releasePatterns(pattern: string | undefined): string[] {
  if (pattern === undefined) {
    return [];
  }
  return pattern
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/** 资产名是否命中任意一个 glob（`*` / `?` / `[...]` 都支持；无 glob 时取全部资产）。 */
export function matchAsset(name: string, patterns: readonly string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => matchesGlob(name, pattern));
}

/** 文件大小；不存在（或读不到）时给 undefined，用来判断是否已下载完整。 */
async function fileSize(path: string): Promise<number | undefined> {
  try {
    const info = await stat(path);
    return info.size;
  } catch {
    return undefined;
  }
}

/** Regular files directly inside `dir`, with their sizes, sorted by name. */
async function listReleaseFiles(dir: string): Promise<ReleaseFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: ReleaseFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(dir, entry.name);
    const info = await stat(path);
    files.push({ name: entry.name, path, bytes: info.size });
  }
  return files.toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * `download-github-release-assets`: 把一个 release 的资产（或源码归档）下载到
 * `releaseAssetDir`，用 `gh auth token` 的凭据，因此私有仓库可用、也不受 shell 沙箱的网络
 * 限制。
 *
 * 先解析 release（缺 tag 时取 latest）：tag 不存在与「glob 没匹配到资产」是两种不同的答案，
 * 后者要把该 release 实际的可选资产名列出来，模型才知道下一步怎么改。
 */
export async function downloadReleaseAssets(
  gh: GhClient,
  call: ToolCall<ReleaseDownloadParams>,
): Promise<StructuredResultOf<typeof releaseDownloadSchema> | StructuredFailureResult> {
  const { params, ctx, signal } = call;
  const patterns = releasePatterns(params.pattern);
  if (params.archive !== undefined && patterns.length > 0) {
    throw new Error(
      "pattern and archive are mutually exclusive (pick asset globs or the source archive)",
    );
  }

  const {
    fullName: effectiveRepo,
    owner,
    name: repoName,
  } = await resolveRepoTarget(params.repo, signal, ctx.cwd, params);
  const view = Value.Parse(
    releaseViewSchema,
    await gh.reads.release(owner, repoName, params.tag, signal),
  );

  const assetNames = view.assets.map((asset) => asset.name);
  const dir = releaseAssetDir(effectiveRepo, view.tag_name);
  await mkdir(dir, { recursive: true });

  if (params.archive === undefined) {
    const selected = view.assets.filter((asset) => matchAsset(asset.name, patterns));
    if (selected.length === 0 && patterns.length > 0) {
      throw new Error(
        `no asset of ${effectiveRepo}@${view.tag_name} matched ${JSON.stringify(patterns)}; the release has: ${assetNames.join(", ") || "(no assets)"}`,
      );
    }
    for (const asset of selected) {
      const destPath = join(dir, asset.name);
      // 同名且大小一致视为已完成（缓存目录里的半截文件不该被当成结果）
      const existing = await fileSize(destPath);
      if (existing === asset.size) {
        continue;
      }
      await gh.reads.downloadAssetTo(owner, repoName, asset.id, destPath, signal);
    }
  } else {
    const extension = params.archive === "zip" ? "zip" : "tar.gz";
    // 归档是仓库源码的 tarball / zipball，名字由我们定（gh 用的是 `<owner>-<repo>-<tag>`）
    const destPath = join(dir, `${repoName}-${view.tag_name}.${extension}`);
    await gh.reads.downloadArchiveTo(
      owner,
      repoName,
      params.archive,
      view.tag_name,
      destPath,
      signal,
    );
  }

  const files = await listReleaseFiles(dir);
  const payload = { repo: effectiveRepo, tag: view.tag_name, dir, files };
  const pendant: ToolPendant | undefined = subtitlePendant(
    { repo: effectiveRepo, tag: view.tag_name },
    "tag",
  );

  if (files.length === 0 && params.archive === undefined) {
    const text = `Nothing to download from ${effectiveRepo}@${view.tag_name}: the release has no assets (try archive for the source tarball)`;
    return {
      content: [{ type: "text", text }],
      details: {
        ...payload,
        available_assets: assetNames,
        input: params,
        ...(pendant && { pendant }),
      },
      structuredResult: structuredFailure(text),
    };
  }

  return withStructuredResult(
    {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: { ...payload, input: params, ...(pendant && { pendant }) },
    },
    payload,
  );
}

export function addDownloadReleaseAssetsTool(gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "download-github-release-assets",
      label: "GitHub Release Download",
      description:
        "Download a GitHub release's assets (or its source archive) into " +
        "~/.cache/pi/github/releases/<owner>/<repo>/<tag>/ using the GitHub credentials, " +
        "so private repositories and large binaries work where a plain HTTP fetch cannot. " +
        "Files already in that directory are kept, never re-fetched. The result is the JSON " +
        "summary {repo, tag, dir, files:[{name, path, bytes}]} listing everything now in the " +
        "directory; file contents are not echoed. Read the entries you need from `path`.",
      promptSnippet: "Download GitHub release assets",
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: "OWNER/REPO (defaults to current repo)" })),
        tag: Type.Optional(
          Type.String({ description: "Release tag (defaults to the latest release)" }),
        ),
        pattern: Type.Optional(
          Type.String({
            description:
              'Comma-separated glob patterns for asset names, e.g. "*.tar.gz,*.deb" (default: every asset)',
          }),
        ),
        archive: Type.Optional(
          Type.Union([Type.Literal("zip"), Type.Literal("tar.gz")], {
            description: "Download the release's source archive instead of its assets",
          }),
        ),
      }),
      structuredSchema: releaseDownloadSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        return downloadReleaseAssets(gh, { params, ctx, signal });
      },
    }),
  );
}
