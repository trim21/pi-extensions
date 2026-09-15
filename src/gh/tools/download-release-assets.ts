import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { type ToolPendant } from "../../lib/pendant.js";
import {
  type GhClient,
  GhError,
  ghExec,
  repoArgs,
  resolveRepo,
  splitRepo,
  subtitlePendant,
  type ToolCall,
  type ToolResult,
} from "../base.js";

interface ReleaseDownloadParams {
  repo?: string;
  tag?: string;
  pattern?: string;
  archive?: "zip" | "tar.gz";
}

/** `gh release view --json tagName,assets` 里本工具真正读取的字段。 */
const releaseViewSchema = Type.Object({
  tagName: Type.String(),
  assets: Type.Array(Type.Object({ name: Type.String(), size: Type.Number() })),
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

/** Split the comma-separated `pattern` toolcall parameter into gh pattern values. */
export function releasePatterns(pattern: string | undefined): string[] {
  if (pattern === undefined) return [];
  return pattern
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

/**
 * The `gh release download` argv. `--skip-existing` is always on: the download
 * directory is a cache, and rewriting a file that is already there would pull
 * the ground out from under anything reading it.
 */
export function releaseDownloadArgs(options: {
  tag: string;
  repo: string;
  dir: string;
  patterns: readonly string[];
  archive?: "zip" | "tar.gz";
}): string[] {
  const { tag, repo, dir, patterns, archive } = options;
  const args = ["release", "download", tag, ...repoArgs(repo)];
  if (archive !== undefined) args.push("--archive", archive);
  for (const pattern of patterns) args.push("--pattern", pattern);
  args.push("--dir", dir, "--skip-existing");
  return args;
}

/** Regular files directly inside `dir`, with their sizes, sorted by name. */
async function listReleaseFiles(dir: string): Promise<ReleaseFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: ReleaseFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    const info = await stat(path);
    files.push({ name: entry.name, path, bytes: info.size });
  }
  return files.toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * `gh release download` answers this exact message when a `--pattern` matched no
 * asset. It is the only signal the CLI offers, so the enrichment below degrades
 * to gh's own error (still thrown) if the wording ever changes.
 */
const GH_NO_ASSET_MATCH = "no assets match the file pattern";

/**
 * `download-github-release-assets`: fetch a release's assets (or source archive)
 * into `releaseAssetDir` with the gh credentials, so private repositories work
 * and the shell sandbox's network limits do not apply.
 *
 * The tag is resolved through `gh release view` before downloading: a tag that
 * does not exist and a pattern that matched nothing are different answers, and
 * the release's own asset names are what the model needs to fix the second one.
 */
export async function downloadReleaseAssets(
  call: ToolCall<ReleaseDownloadParams>,
): Promise<ToolResult> {
  const { params, ctx, signal } = call;
  const patterns = releasePatterns(params.pattern);
  if (params.archive !== undefined && patterns.length > 0) {
    throw new Error(
      "pattern and archive are mutually exclusive (pick asset globs or the source archive)",
    );
  }

  const effectiveRepo = await resolveRepo(params.repo, signal, ctx.cwd, params);
  const view = Value.Parse(
    releaseViewSchema,
    JSON.parse(
      await ghExec(
        [
          "release",
          "view",
          ...(params.tag === undefined ? [] : [params.tag]),
          ...repoArgs(effectiveRepo),
          "--json",
          "tagName,assets",
        ],
        { cwd: ctx.cwd, signal, input: params },
      ),
    ),
  );

  const assetNames = view.assets.map((asset) => asset.name);
  const dir = releaseAssetDir(effectiveRepo, view.tagName);
  await mkdir(dir, { recursive: true });
  try {
    await ghExec(
      releaseDownloadArgs({
        tag: view.tagName,
        repo: effectiveRepo,
        dir,
        patterns,
        ...(params.archive !== undefined && { archive: params.archive }),
      }),
      { cwd: ctx.cwd, signal, input: params },
    );
  } catch (error) {
    // gh names the fault but not the choices; the release's asset list turns a
    // dead end into the next toolcall.
    if (error instanceof GhError && error.stderr.includes(GH_NO_ASSET_MATCH)) {
      throw new Error(
        `no asset of ${effectiveRepo}@${view.tagName} matched ${JSON.stringify(patterns)}; the release has: ${assetNames.join(", ") || "(no assets)"}`,
        { cause: error },
      );
    }
    throw error;
  }

  const files = await listReleaseFiles(dir);
  const payload = { repo: effectiveRepo, tag: view.tagName, dir, files };
  const pendant: ToolPendant | undefined = subtitlePendant(
    { repo: effectiveRepo, tag: view.tagName },
    "tag",
  );

  if (files.length === 0 && params.archive === undefined) {
    return {
      content: [
        {
          type: "text",
          text: `Nothing to download from ${effectiveRepo}@${view.tagName}: the release has no assets (try archive for the source tarball)`,
        },
      ],
      details: {
        ...payload,
        available_assets: assetNames,
        input: params,
        ...(pendant && { pendant }),
      },
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: { ...payload, input: params, ...(pendant && { pendant }) },
  };
}

export function addDownloadReleaseAssetsTool(_gh: GhClient, pi: ExtensionAPI) {
  pi.registerTool({
    name: "download-github-release-assets",
    label: "GitHub Release Download",
    description:
      "Download a GitHub release's assets (or its source archive) into " +
      "~/.cache/pi/github/releases/<owner>/<repo>/<tag>/ using the gh CLI's credentials, " +
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      return downloadReleaseAssets({ params, ctx, signal });
    },
  });
}
