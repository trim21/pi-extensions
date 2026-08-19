/**
 * Search1API 搜索：请求构造、响应解析与结果整理。
 *
 * 搜索响应不做 AI 预消化，直接返回整理后的结构化结果（title/url/snippet，
 * crawl_results 开启时含内联正文）——模型自己读，零额外模型调用。
 */
import { Type } from "typebox";
import { Value } from "typebox/value";

const SEARCH_URL = "https://api.search1api.com/search";
const TIMEOUT_MS = 60_000;

const hitSchema = Type.Object({
  title: Type.Union([Type.String(), Type.Null()]),
  link: Type.Union([Type.String(), Type.Null()]),
  snippet: Type.Union([Type.String(), Type.Null()]),
  content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const searchResponseSchema = Type.Object(
  { results: Type.Array(hitSchema) },
  { additionalProperties: true },
);

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  content?: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
}

export interface SearchOptions {
  numResults?: number;
  recencyFilter?: string;
  domainFilter?: string[];
  searchService?: string;
  /** 内联抓取前几个结果的正文（crawl_results），可省去后续 web_fetch */
  includeContent?: boolean;
  signal?: AbortSignal;
}

function clampNumResults(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(Math.floor(value), 50));
}

function normalizeDomain(raw: string): string | undefined {
  const input = raw.trim().toLowerCase().replace(/^-/, "").trim();
  if (!input) return undefined;
  try {
    const host = input.includes("://")
      ? new URL(input).hostname
      : new URL(`https://${input}`).hostname;
    return host.replaceAll(/^\.+|\.+$/g, "") || undefined;
  } catch {
    return input.split("/", 1)[0]?.split(":", 1)[0] || undefined;
  }
}

function splitDomainFilter(domainFilter: string[] | undefined): {
  includeSites: string[];
  excludeSites: string[];
} {
  const includeSites: string[] = [];
  const excludeSites: string[] = [];
  for (const raw of domainFilter ?? []) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    (raw.trimStart().startsWith("-") ? excludeSites : includeSites).push(domain);
  }
  return { includeSites, excludeSites };
}

export function buildSearchBody(query: string, options: SearchOptions): Record<string, unknown> {
  const numResults = clampNumResults(options.numResults);
  const { includeSites, excludeSites } = splitDomainFilter(options.domainFilter);
  const body: Record<string, unknown> = {
    query,
    max_results: numResults,
    crawl_results: options.includeContent ? Math.min(numResults, 5) : 0,
  };
  if (options.recencyFilter) body.time_range = options.recencyFilter;
  if (options.searchService) body.search_service = options.searchService;
  if (includeSites.length > 0) body.include_sites = includeSites;
  if (excludeSites.length > 0) body.exclude_sites = excludeSites;
  return body;
}

function mapHits(
  results: {
    title: string | null;
    link: string | null;
    snippet: string | null;
    content?: string | null;
  }[],
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const item of results) {
    const url = item.link?.trim();
    if (!url) continue;
    const hit: SearchHit = {
      title: item.title?.trim() || url,
      url,
      snippet: item.snippet?.replaceAll(/\s+/g, " ").trim() || "",
    };
    const content = item.content?.trim();
    if (content) hit.content = content;
    hits.push(hit);
  }
  return hits;
}

/** 合并调用方 signal 与超时；调用方未传时仍有超时兜底 */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function searchWeb(
  query: string,
  apiKey: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const response = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildSearchBody(query, options)),
    signal: withTimeout(options.signal, TIMEOUT_MS),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Search1API error ${response.status}: ${raw.slice(0, 300)}`);
  }
  const parsed = Value.Parse(searchResponseSchema, JSON.parse(raw));
  return { query, hits: mapHits(parsed.results) };
}
