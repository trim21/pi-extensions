/**
 * GitHub Readonly Extension
 *
 * Registers read-only tools that forward to the local `gh` CLI.
 * All tools are readonly — no mutations (create/update/delete) are exposed.
 *
 * Prerequisites: `gh` must be installed and authenticated.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Local StringEnum for Google-compatible string enums (avoids @earendil-works/pi-ai dependency) */
function StringEnum<T extends readonly string[]>(values: T, opts?: { description?: string }) {
  // Use Union of Literals — works with OpenAI, Google needs the enum annotation.
  // For maximum compatibility, include both schema forms.
  return Type.String({
    enum: [...values] as unknown as string[],
    description: opts?.description,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_OUTPUT = 50 * 1024; // 50KB
const MAX_LINES = 2000;

async function gh(
  pi: ExtensionAPI,
  args: string[],
  opts?: { signal?: AbortSignal; timeout?: number },
) {
  return pi.exec("gh", args, {
    signal: opts?.signal,
    timeout: opts?.timeout,
  });
}

function truncate(text: string): string {
  const lines = text.split("\n");
  const bytes = Buffer.byteLength(text, "utf-8");
  if (lines.length <= MAX_LINES && bytes <= MAX_OUTPUT) return text;

  let result = "";
  let used = 0;
  let kept = 0;
  for (const line of lines) {
    const lb = Buffer.byteLength(line + "\n", "utf-8");
    if (kept >= MAX_LINES || used + lb > MAX_OUTPUT) break;
    result += line + "\n";
    used += lb;
    kept++;
  }
  const skipped = lines.length - kept;
  if (skipped > 0)
    result += `\n[Output truncated: showing ${kept}/${lines.length} lines (${(used / 1024).toFixed(1)}KB of ${(bytes / 1024).toFixed(1)}KB). Use more specific filters.]`;
  return result.trimEnd();
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

interface GhResult {
  content: [{ type: "text"; text: string }];
  details: { exitCode: number | null };
}

/** Build gh CLI args from params, stripping optional undefineds. */
function buildArgs(base: string[], params: Record<string, unknown>, flags: Record<string, string>) {
  const args = [...base];
  for (const [key, flag] of Object.entries(flags)) {
    const v = params[key];
    if (v !== undefined && v !== null) {
      if (typeof v === "boolean") args.push(v ? flag : `${flag}=false`);
      else args.push(flag, String(v));
    }
  }
  return args;
}

/** Execute a gh --json command, parse JSON output, return text. */
async function ghJson(
  pi: ExtensionAPI,
  args: string[],
  params: Record<string, unknown>,
  flags: Record<string, string>,
  defaultJsonFields: string,
  signal?: AbortSignal,
): Promise<GhResult> {
  const full = buildArgs(args, params, flags);
  // Ensure --json is present
  if (!full.includes("--json")) {
    full.push("--json", defaultJsonFields);
  }
  const result = await gh(pi, full, { signal });
  if (result.code !== 0) {
    return {
      content: [
        {
          type: "text",
          text: `gh command failed (exit ${result.code}):\n${result.stderr || result.stdout}`,
        },
      ],
      details: { exitCode: result.code },
    };
  }
  const parsed = safeJson(result.stdout);
  const text = parsed ? JSON.stringify(parsed, null, 2) : result.stdout;
  return {
    content: [{ type: "text", text: truncate(text) }],
    details: { exitCode: result.code },
  };
}

/** Execute a plain gh command (no JSON parsing). */
async function ghPlain(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<GhResult> {
  const result = await gh(pi, args, { signal });
  if (result.code !== 0) {
    return {
      content: [
        {
          type: "text",
          text: `gh command failed (exit ${result.code}):\n${result.stderr || result.stdout}`,
        },
      ],
      details: { exitCode: result.code },
    };
  }
  return {
    content: [{ type: "text", text: truncate(result.stdout) }],
    details: { exitCode: result.code },
  };
}

// ---------------------------------------------------------------------------
// Tool parameter helpers
// ---------------------------------------------------------------------------

function repoParam(desc?: string) {
  return Type.Optional(
    Type.String({
      description: desc ?? "Target repo (owner/repo). Uses current repo if omitted.",
    }),
  );
}

function limitParam(def: number) {
  return Type.Optional(Type.Number({ description: `Max results (default: ${def})` }));
}

function jsonParam(def: string) {
  return Type.Optional(
    Type.String({ description: `Comma-separated JSON fields (default: ${def})` }),
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // ── gh_issue_list ────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_issue_list",
    label: "GH List Issues",
    description:
      "List GitHub issues. Supports --assignee, --label, --state, --limit, --search, --milestone, --author.",
    promptSnippet:
      "List GitHub issues (supports --assignee, --label, --state, --limit, --search, --milestone, --author)",
    promptGuidelines: [
      "Use gh_issue_list to list GitHub issues filtered by assignee, label, state, milestone, author, or search terms.",
    ],
    parameters: Type.Object({
      repo: repoParam(),
      state: Type.Optional(StringEnum(["open", "closed", "all"] as const)),
      assignee: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      milestone: Type.Optional(Type.String()),
      author: Type.Optional(Type.String()),
      search: Type.Optional(Type.String()),
      limit: limitParam(30),
      jsonFields: jsonParam("number,title,state,labels,assignees,updatedAt,url"),
    }),
    async execute(_id, params, signal) {
      return ghJson(
        pi,
        ["issue", "list"],
        params,
        {
          repo: "--repo",
          state: "--state",
          assignee: "--assignee",
          label: "--label",
          milestone: "--milestone",
          author: "--author",
          search: "--search",
          limit: "--limit",
          jsonFields: "--json",
        },
        "number,title,state,labels,assignees,updatedAt,url",
        signal,
      );
    },
  });

  // ── gh_issue_view ────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_issue_view",
    label: "GH View Issue",
    description: "View a GitHub issue by number.",
    promptSnippet: "View a GitHub issue by number",
    promptGuidelines: ["Use gh_issue_view to see full details of a specific GitHub issue."],
    parameters: Type.Object({
      repo: repoParam(),
      number: Type.Number({ description: "Issue number" }),
      jsonFields: jsonParam(
        "number,title,body,state,labels,assignees,comments,url,createdAt,updatedAt",
      ),
      includeComments: Type.Optional(
        Type.Boolean({ description: "Also fetch comments (default: false)" }),
      ),
    }),
    async execute(_id, params, signal) {
      const r = await ghJson(
        pi,
        ["issue", "view", String(params.number)],
        params,
        { repo: "--repo", jsonFields: "--json" },
        "number,title,body,state,labels,assignees,comments,url,createdAt,updatedAt",
        signal,
      );
      if (params.includeComments && r.details?.exitCode === 0) {
        const cr = await ghPlain(
          pi,
          [
            "issue",
            "view",
            String(params.number),
            "--comments",
            ...(params.repo ? ["--repo", params.repo] : []),
          ],
          signal,
        );
        if (cr.content?.[0]?.text) {
          r.content[0].text += "\n\n--- Comments ---\n" + cr.content[0].text;
        }
      }
      return r;
    },
  });

  // ── gh_issue_comments ────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_issue_comments",
    label: "GH Issue Comments",
    description: "List comments on a GitHub issue.",
    promptSnippet: "List comments on a GitHub issue",
    parameters: Type.Object({
      repo: repoParam(),
      number: Type.Number({ description: "Issue number" }),
    }),
    async execute(_id, params, signal) {
      return ghPlain(
        pi,
        [
          "issue",
          "view",
          String(params.number),
          "--comments",
          ...(params.repo ? ["--repo", params.repo] : []),
        ],
        signal,
      );
    },
  });

  // ── gh_pr_list ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_pr_list",
    label: "GH List PRs",
    description:
      "List GitHub pull requests. Supports --assignee, --label, --state, --limit, --search, --base, --head, --author, --draft.",
    promptSnippet:
      "List GitHub PRs (supports --assignee, --label, --state, --limit, --search, --base, --head, --author, --draft)",
    promptGuidelines: [
      "Use gh_pr_list to list GitHub PRs filtered by state, labels, author, branch, draft status, or search terms.",
    ],
    parameters: Type.Object({
      repo: repoParam(),
      state: Type.Optional(StringEnum(["open", "closed", "merged", "all"] as const)),
      assignee: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      author: Type.Optional(Type.String()),
      base: Type.Optional(Type.String()),
      head: Type.Optional(Type.String()),
      search: Type.Optional(Type.String()),
      draft: Type.Optional(Type.Boolean()),
      limit: limitParam(30),
      jsonFields: jsonParam(
        "number,title,state,labels,author,headRefName,baseRefName,updatedAt,url,draft",
      ),
    }),
    async execute(_id, params, signal) {
      return ghJson(
        pi,
        ["pr", "list"],
        params,
        {
          repo: "--repo",
          state: "--state",
          assignee: "--assignee",
          label: "--label",
          author: "--author",
          base: "--base",
          head: "--head",
          search: "--search",
          draft: "--draft",
          limit: "--limit",
          jsonFields: "--json",
        },
        "number,title,state,labels,author,headRefName,baseRefName,updatedAt,url,draft",
        signal,
      );
    },
  });

  // ── gh_pr_view ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_pr_view",
    label: "GH View PR",
    description: "View a GitHub pull request by number.",
    promptSnippet: "View a GitHub pull request by number",
    promptGuidelines: ["Use gh_pr_view to see full details of a specific pull request."],
    parameters: Type.Object({
      repo: repoParam(),
      number: Type.Number({ description: "PR number" }),
      jsonFields: jsonParam(
        "number,title,body,state,labels,author,headRefName,baseRefName,assignees,reviews,mergedAt,updatedAt,url",
      ),
      includeComments: Type.Optional(
        Type.Boolean({ description: "Also fetch comments (default: false)" }),
      ),
    }),
    async execute(_id, params, signal) {
      const r = await ghJson(
        pi,
        ["pr", "view", String(params.number)],
        params,
        { repo: "--repo", jsonFields: "--json" },
        "number,title,body,state,labels,author,headRefName,baseRefName,assignees,reviews,mergedAt,updatedAt,url",
        signal,
      );
      if (params.includeComments && r.details?.exitCode === 0) {
        const cr = await ghPlain(
          pi,
          [
            "pr",
            "view",
            String(params.number),
            "--comments",
            ...(params.repo ? ["--repo", params.repo] : []),
          ],
          signal,
        );
        if (cr.content?.[0]?.text) {
          r.content[0].text += "\n\n--- Comments & Reviews ---\n" + cr.content[0].text;
        }
      }
      return r;
    },
  });

  // ── gh_pr_comments ───────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_pr_comments",
    label: "GH PR Comments",
    description: "List comments and reviews on a pull request.",
    promptSnippet: "List comments and reviews on a PR",
    parameters: Type.Object({
      repo: repoParam(),
      number: Type.Number({ description: "PR number" }),
    }),
    async execute(_id, params, signal) {
      return ghPlain(
        pi,
        [
          "pr",
          "view",
          String(params.number),
          "--comments",
          ...(params.repo ? ["--repo", params.repo] : []),
        ],
        signal,
      );
    },
  });

  // ── gh_pr_diff ───────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_pr_diff",
    label: "GH PR Diff",
    description: "View the diff of a pull request.",
    promptSnippet: "View the diff of a pull request",
    promptGuidelines: ["Use gh_pr_diff to see the code changes in a pull request."],
    parameters: Type.Object({
      repo: repoParam(),
      number: Type.Number({ description: "PR number" }),
      color: Type.Optional(StringEnum(["auto", "always", "never"] as const)),
    }),
    async execute(_id, params, signal) {
      return ghPlain(
        pi,
        buildArgs(["pr", "diff", String(params.number)], params, {
          repo: "--repo",
          color: "--color",
        }),
        signal,
      );
    },
  });

  // ── gh_repo_view ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_repo_view",
    label: "GH View Repo",
    description: "View details of a GitHub repository.",
    promptSnippet: "View GitHub repository details (name, description, stars, etc.)",
    parameters: Type.Object({
      repo: repoParam(),
      jsonFields: jsonParam(
        "name,description,url,stargazerCount,forkCount,primaryLanguage,defaultBranchRef,createdAt,updatedAt,owner",
      ),
    }),
    async execute(_id, params, signal) {
      return ghJson(
        pi,
        ["repo", "view"],
        params,
        { repo: "--repo", jsonFields: "--json" },
        "name,description,url,stargazerCount,forkCount,primaryLanguage,defaultBranchRef,createdAt,updatedAt,owner",
        signal,
      );
    },
  });

  // ── gh_repo_list ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_repo_list",
    label: "GH List Repos",
    description: "List GitHub repositories for a user or organization.",
    promptSnippet: "List GitHub repos for a user or org",
    parameters: Type.Object({
      owner: Type.Optional(
        Type.String({
          description: "User/org to list repos for. Uses authenticated user if omitted.",
        }),
      ),
      limit: limitParam(30),
      jsonFields: jsonParam(
        "name,description,url,stargazerCount,forkCount,primaryLanguage,updatedAt",
      ),
      language: Type.Optional(Type.String()),
      topic: Type.Optional(Type.String()),
      visibility: Type.Optional(StringEnum(["public", "private", "all"] as const)),
    }),
    async execute(_id, params, signal) {
      const args: string[] = ["repo", "list"];
      if (params.owner) args.push(params.owner);
      return ghJson(
        pi,
        args,
        params,
        {
          limit: "--limit",
          language: "--language",
          topic: "--topic",
          visibility: "--visibility",
          jsonFields: "--json",
        },
        "name,description,url,stargazerCount,forkCount,primaryLanguage,updatedAt",
        signal,
      );
    },
  });

  // ── gh_search ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_search",
    label: "GH Search",
    description: "Search GitHub for issues, PRs, repositories, or code.",
    promptSnippet: "Search GitHub issues, PRs, repos, or code (read-only)",
    promptGuidelines: [
      "Use gh_search to find issues, pull requests, repositories, or code on GitHub using search terms.",
    ],
    parameters: Type.Object({
      type: StringEnum(["issues", "prs", "repos", "code"] as const, {
        description: "What to search for",
      }),
      query: Type.String({ description: "Search query (same syntax as GitHub web search)." }),
      owner: Type.Optional(Type.String()),
      language: Type.Optional(Type.String()),
      limit: limitParam(30),
      sort: Type.Optional(
        StringEnum(["best-match", "reactions", "updated", "created", "stars", "forks"] as const),
      ),
      jsonFields: Type.Optional(
        Type.String({ description: "Comma-separated JSON fields (default depends on type)" }),
      ),
    }),
    async execute(_id, params, signal) {
      const defaults: Record<string, string> = {
        issues: "number,title,state,labels,repository,updatedAt,url",
        prs: "number,title,state,labels,repository,updatedAt,url",
        repos: "name,description,url,stargazerCount,forkCount,language,updatedAt",
        code: "path,repository",
      };
      const args = ["search", params.type, params.query];
      return ghJson(
        pi,
        args,
        params,
        {
          owner: "--owner",
          language: "--language",
          limit: "--limit",
          sort: "--sort",
          jsonFields: "--json",
        },
        params.jsonFields ?? defaults[params.type],
        signal,
      );
    },
  });

  // ── gh_release_list ──────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_release_list",
    label: "GH List Releases",
    description: "List releases for a GitHub repository.",
    promptSnippet: "List GitHub releases",
    parameters: Type.Object({
      repo: repoParam(),
      limit: limitParam(30),
      jsonFields: jsonParam("tagName,name,publishedAt,url,isLatest,isPrerelease"),
    }),
    async execute(_id, params, signal) {
      return ghJson(
        pi,
        ["release", "list"],
        params,
        { repo: "--repo", limit: "--limit", jsonFields: "--json" },
        "tagName,name,publishedAt,url,isLatest,isPrerelease",
        signal,
      );
    },
  });

  // ── gh_release_view ──────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_release_view",
    label: "GH View Release",
    description: "View details of a GitHub release by tag name.",
    promptSnippet: "View a GitHub release by tag name",
    parameters: Type.Object({
      repo: repoParam(),
      tag: Type.String({ description: "Release tag name (e.g. v1.0.0)" }),
      jsonFields: jsonParam("tagName,name,body,publishedAt,url,assets"),
    }),
    async execute(_id, params, signal) {
      return ghJson(
        pi,
        ["release", "view", params.tag],
        params,
        { repo: "--repo", jsonFields: "--json" },
        "tagName,name,body,publishedAt,url,assets",
        signal,
      );
    },
  });

  // ── gh_workflow_list ─────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_workflow_list",
    label: "GH List Workflows",
    description: "List GitHub Actions workflows.",
    promptSnippet: "List GitHub Actions workflows",
    parameters: Type.Object({
      repo: repoParam(),
      limit: limitParam(50),
      jsonFields: jsonParam("id,name,path,state,updatedAt"),
    }),
    async execute(_id, params, signal) {
      return ghJson(
        pi,
        ["workflow", "list"],
        params,
        { repo: "--repo", limit: "--limit", jsonFields: "--json" },
        "id,name,path,state,updatedAt",
        signal,
      );
    },
  });

  // ── gh_run_list ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_run_list",
    label: "GH List Runs",
    description: "List GitHub Actions workflow runs.",
    promptSnippet: "List GitHub Actions workflow runs",
    promptGuidelines: [
      "Use gh_run_list to list recent GitHub Actions workflow runs. Optionally filter by workflow name, status, or branch.",
    ],
    parameters: Type.Object({
      repo: repoParam(),
      workflow: Type.Optional(Type.String({ description: "Filter by workflow name or ID" })),
      branch: Type.Optional(Type.String()),
      status: Type.Optional(
        StringEnum(["completed", "in_progress", "queued", "failed", "success"] as const),
      ),
      limit: limitParam(20),
      jsonFields: jsonParam("databaseId,name,status,conclusion,headBranch,createdAt,url,event"),
    }),
    async execute(_id, params, signal) {
      return ghJson(
        pi,
        ["run", "list"],
        params,
        {
          repo: "--repo",
          workflow: "--workflow",
          branch: "--branch",
          status: "--status",
          limit: "--limit",
          jsonFields: "--json",
        },
        "databaseId,name,status,conclusion,headBranch,createdAt,url,event",
        signal,
      );
    },
  });

  // ── gh_run_view ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_run_view",
    label: "GH View Run",
    description: "View details of a GitHub Actions workflow run.",
    promptSnippet: "View a GitHub Actions workflow run",
    parameters: Type.Object({
      repo: repoParam(),
      runId: Type.String({ description: "Run ID (databaseId)" }),
      jsonFields: jsonParam(
        "databaseId,name,status,conclusion,headBranch,createdAt,updatedAt,url,event,displayTitle",
      ),
      log: Type.Optional(
        Type.Boolean({ description: "Also fetch run log (can be large; default: false)" }),
      ),
      logFailures: Type.Optional(Type.Boolean({ description: "Fetch only failed job logs" })),
    }),
    async execute(_id, params, signal) {
      const r = await ghJson(
        pi,
        ["run", "view", params.runId],
        params,
        { repo: "--repo", jsonFields: "--json" },
        "databaseId,name,status,conclusion,headBranch,createdAt,updatedAt,url,event,displayTitle",
        signal,
      );
      if (r.details?.exitCode === 0) {
        if (params.log) {
          const lr = await ghPlain(
            pi,
            ["run", "view", params.runId, "--log", ...(params.repo ? ["--repo", params.repo] : [])],
            signal,
          );
          if (lr.content?.[0]?.text) r.content[0].text += "\n\n--- Log ---\n" + lr.content[0].text;
        }
        if (params.logFailures) {
          const fr = await ghPlain(
            pi,
            [
              "run",
              "view",
              params.runId,
              "--log-failed",
              ...(params.repo ? ["--repo", params.repo] : []),
            ],
            signal,
          );
          if (fr.content?.[0]?.text)
            r.content[0].text += "\n\n--- Failed Jobs Log ---\n" + fr.content[0].text;
        }
      }
      return r;
    },
  });

  // ── gh_gist_list ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_gist_list",
    label: "GH List Gists",
    description: "List gists for the authenticated user.",
    promptSnippet: "List gists",
    parameters: Type.Object({
      limit: limitParam(30),
      public: Type.Optional(Type.Boolean({ description: "Show only public gists" })),
      secret: Type.Optional(Type.Boolean({ description: "Show only secret gists" })),
      jsonFields: jsonParam("id,description,files,public,updatedAt,createdAt"),
    }),
    async execute(_id, params, signal) {
      return ghJson(
        pi,
        ["gist", "list"],
        params,
        { limit: "--limit", public: "--public", secret: "--secret", jsonFields: "--json" },
        "id,description,files,public,updatedAt,createdAt",
        signal,
      );
    },
  });

  // ── gh_gist_view ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_gist_view",
    label: "GH View Gist",
    description: "View a gist by ID.",
    promptSnippet: "View a gist",
    parameters: Type.Object({
      gistId: Type.String({ description: "Gist ID (hash)" }),
      raw: Type.Optional(Type.String({ description: "Specific file to view raw content" })),
      jsonFields: jsonParam("id,description,files,public,updatedAt,createdAt,owner"),
    }),
    async execute(_id, params, signal) {
      if (params.raw) {
        return ghPlain(
          pi,
          ["gist", "view", params.gistId, "--raw", "--filename", params.raw],
          signal,
        );
      }
      return ghJson(
        pi,
        ["gist", "view", params.gistId],
        params,
        { jsonFields: "--json" },
        "id,description,files,public,updatedAt,createdAt,owner",
        signal,
      );
    },
  });

  // ── gh_user ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_user",
    label: "GH User/Org Info",
    description: "View GitHub user or organization profile info.",
    promptSnippet: "View GitHub user or org profile info",
    parameters: Type.Object({
      user: Type.Optional(
        Type.String({ description: "Username. Uses authenticated user if omitted." }),
      ),
      jsonFields: jsonParam(
        "login,name,bio,company,location,email,websiteUrl,twitterUsername,followersCount,followingCount,createdAt",
      ),
    }),
    async execute(_id, params, signal) {
      return ghJson(
        pi,
        params.user ? ["api", `users/${params.user}`] : ["api", "user"],
        params,
        { jsonFields: "--jq" }, // gh api uses --jq, not --json
        ".",
        signal,
      );
    },
  });

  // ── gh_auth_status ───────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_auth_status",
    label: "GH Auth Status",
    description: "Check gh CLI authentication status.",
    promptSnippet: "Check gh CLI authentication status",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const result = await gh(pi, ["auth", "status"], { signal });
      return {
        content: [{ type: "text", text: truncate(result.stdout || result.stderr) }],
        details: { exitCode: result.code },
      };
    },
  });

  // ── gh_api (raw GET) ─────────────────────────────────────────────────

  pi.registerTool({
    name: "gh_api",
    label: "GH API (GET)",
    description:
      "Access a GitHub REST API endpoint (GET only). Use for endpoints not covered by other gh tools.",
    promptSnippet: "Raw GitHub REST API GET request",
    promptGuidelines: [
      "Use gh_api to query GitHub REST API endpoints (GET only) when no dedicated gh_readonly tool exists. E.g. gh_api endpoint='repos/owner/repo/branches'.",
    ],
    parameters: Type.Object({
      endpoint: Type.String({
        description:
          "REST API endpoint path (without /api/v3/ prefix). E.g. 'repos/owner/repo/issues' or 'orgs/org/members'.",
      }),
      jq: Type.Optional(
        Type.String({
          description: "jq filter for the JSON response (e.g. '.[].login' to extract login names).",
        }),
      ),
      rawFields: Type.Optional(
        Type.String({
          description:
            "Comma-separated field names to include (uses --jq internally). Overrides jq if set.",
        }),
      ),
      paginate: Type.Optional(
        Type.Boolean({
          description: "Fetch all pages of results (default: false, shows first page only)",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      const args: string[] = ["api", params.endpoint];

      if (params.rawFields) {
        args.push("--jq", "."); // Return raw JSON, caller will parse
      } else if (params.jq) {
        args.push("--jq", params.jq);
      }

      if (params.paginate) args.push("--paginate");

      const result = await gh(pi, args, { signal });
      if (result.code !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `gh api failed (exit ${result.code}):\n${result.stderr || result.stdout}`,
            },
          ],
          details: { exitCode: result.code },
        };
      }

      const parsed = safeJson(result.stdout);
      const text = parsed ? JSON.stringify(parsed, null, 2) : result.stdout;
      return {
        content: [{ type: "text", text: truncate(text) }],
        details: { exitCode: result.code },
      };
    },
  });
}
