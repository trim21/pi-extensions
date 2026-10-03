import { Type } from "typebox";

import { parseWithSchema } from "../../lib/parse-with-schema.js";
import { defineStructuredTool, type ToolBus } from "../../lib/tool-bus.js";
import {
  type GhClient,
  ghExec,
  subtitlePendant,
  toToolResult,
  withStructuredResult,
} from "../base.js";
import { renderRepoView } from "../render.js";
import { ghRepoPayloadSchema, ghRepoViewSchema } from "../schemas.js";

/** 我们向 gh 要的仓库字段，与渲染和载荷一一对应。 */
const REPO_FIELDS = [
  "name",
  "nameWithOwner",
  "description",
  "url",
  "homepageUrl",
  "visibility",
  "isPrivate",
  "isFork",
  "isArchived",
  "stargazerCount",
  "forkCount",
  "primaryLanguage",
  "defaultBranchRef",
  "licenseInfo",
  "issues",
  "pullRequests",
  "pushedAt",
  "createdAt",
  "updatedAt",
].join(",");

export function addReadRepoTool(_gh: GhClient, bus: ToolBus) {
  bus.register(
    defineStructuredTool({
      name: "read-github-repo",
      label: "GitHub Repo",
      description: "Get repository information.",
      promptSnippet: "Read GitHub repo info",
      parameters: Type.Object({
        repo: Type.Optional(Type.String({ description: "OWNER/REPO" })),
      }),
      structuredSchema: ghRepoPayloadSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const { repo } = params;
        const args = ["repo", "view"];
        if (repo) {
          args.push(repo);
        }
        args.push("--json", REPO_FIELDS);
        const stdout = await ghExec(args, { cwd: ctx.cwd, signal, input: params });
        const view = parseWithSchema(ghRepoViewSchema, JSON.parse(stdout));
        const text = renderRepoView(view);
        const result = toToolResult(text, params);
        result.details.pendant = subtitlePendant(params);
        return withStructuredResult(result, { text, repo: view });
      },
    }),
  );
}
