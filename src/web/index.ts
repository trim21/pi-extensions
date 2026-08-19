/**
 * web 扩展：自研 web_search + web_fetch，替代 pi-web-access。
 *
 * - web_search：Search1API 搜索（key 读 ~/.pi/web-search.json 的
 *   search1apiApiKey 或 SEARCH1API_KEY），直接返回整理后的结构化结果。
 * - web_fetch：抓取 URL，SSRF 防护 + readability 提取正文为 markdown。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadSearch1ApiKey } from "./config.js";
import { fetchPage } from "./fetch.js";
import { type SearchHit, searchWeb } from "./search.js";

const MAX_MARKDOWN_BYTES = 100 * 1024;

function truncateMarkdown(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_MARKDOWN_BYTES) return { text, truncated: false };
  const bytes = Buffer.from(text, "utf8");
  const sliced = bytes.subarray(0, MAX_MARKDOWN_BYTES).toString("utf8");
  const cut = sliced.lastIndexOf("\n", sliced.length - 1);
  return { text: (cut > 0 ? sliced.slice(0, cut) : sliced) + "\n…(已截断)", truncated: true };
}

export default function webTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via Search1API and return structured results " +
      "(title/url/snippet, optionally inline content).",
    promptSnippet: "Search the web",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Search query (mutually exclusive with queries)" }),
      ),
      queries: Type.Optional(
        Type.Array(Type.String(), { description: "Multiple queries searched in sequence" }),
      ),
      numResults: Type.Optional(
        Type.Number({ description: "Results per query (default: 5, max: 50)" }),
      ),
      recencyFilter: Type.Optional(
        Type.String({ description: "Filter by recency: day, week, month, year" }),
      ),
      domainFilter: Type.Optional(
        Type.Array(Type.String(), { description: "Limit to domains; prefix with - to exclude" }),
      ),
      searchService: Type.Optional(
        Type.String({
          description:
            "Search engine: google, bing, duckduckgo, github, arxiv, reddit, youtube, etc.",
        }),
      ),
      includeContent: Type.Optional(
        Type.Boolean({ description: "Inline-fetch content for the top results (up to 5)" }),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      try {
        const queries = [...(params.query ? [params.query] : []), ...(params.queries ?? [])]
          .map((q) => q.trim())
          .filter(Boolean)
          .slice(0, 4);
        if (queries.length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "需要提供 query 或 queries（至少一个搜索词）。" }],
            details: { error: "no query" },
          };
        }

        const apiKey = await loadSearch1ApiKey();
        if (!apiKey) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "未找到 Search1API key：请在 ~/.pi/web-search.json 配置 search1apiApiKey，或设置 SEARCH1API_KEY 环境变量。",
              },
            ],
            details: { error: "search1api key not configured" },
          };
        }

        onUpdate?.({
          content: [{ type: "text", text: `正在搜索: ${queries.join(" / ")}` }],
          details: {},
        });

        const common = {
          numResults: params.numResults,
          recencyFilter: params.recencyFilter,
          domainFilter: params.domainFilter,
          searchService: params.searchService,
          includeContent: params.includeContent,
          signal,
        };
        const results = await Promise.all(queries.map((query) => searchWeb(query, apiKey, common)));

        // 按 URL 去重合并
        const seen = new Set<string>();
        const hits: SearchHit[] = [];
        for (const result of results) {
          for (const hit of result.hits) {
            if (seen.has(hit.url)) continue;
            seen.add(hit.url);
            hits.push(hit);
          }
        }
        if (hits.length === 0) {
          return {
            content: [{ type: "text", text: "没有找到结果。" }],
            details: { query: queries, count: 0 },
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(hits, null, 2) }],
          details: {
            query: queries,
            provider: "search1api",
            count: hits.length,
            results: hits,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: `搜索失败: ${message}` }],
          details: { error: message },
        };
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and extract the main content as markdown. SSRF-protected: refuses " +
      "private/internal addresses. Only http/https HTML pages are supported.",
    promptSnippet: "Fetch a web page and extract its content",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
    }),
    async execute(_id, params, signal) {
      try {
        const page = await fetchPage(params.url, signal);
        const { text, truncated } = truncateMarkdown(page.markdown);
        const details: Record<string, unknown> = {
          url: page.url,
          title: page.title,
          bytes: Buffer.byteLength(page.markdown, "utf8"),
          truncated,
        };
        return {
          content: [{ type: "text", text }],
          details,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const details: Record<string, unknown> = { error: message, url: params.url };
        return {
          isError: true,
          content: [{ type: "text", text: `抓取失败: ${message}` }],
          details,
        };
      }
    },
  });
}
