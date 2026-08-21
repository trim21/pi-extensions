/**
 * web_fetch：抓取 URL 并提取正文为 markdown。
 *
 * SSRF 防护：DNS 预解析 + 拒绝私有/保留地址 + 每跳重定向重新校验，
 * 防止把 agent 变成内网探测口。正文提取用 readability 主内容算法。
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 200;

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  return a >= 224; // 224.0.0.0/3 multicast + reserved
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith("::ffff:")) return isPrivateIpv4(lower.slice(7));
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return true; // 非 IP 一律拒绝
}

/** 解析 hostname 的全部地址，任一私有即拒绝，返回解析结果 */
export async function assertPublicHostname(
  hostname: string,
  lookupFn: (hostname: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true }),
): Promise<void> {
  let addresses: { address: string }[];
  try {
    addresses = await lookupFn(hostname);
  } catch (error) {
    throw new Error(
      `域名解析失败 ${hostname}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const blocked = addresses.find(({ address }) => isPrivateAddress(address));
  if (blocked) {
    throw new Error(`拒绝访问内网地址 ${hostname} (${blocked.address})`);
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface FetchedPage {
  url: string;
  title: string;
  markdown: string;
}

/** 手动跟随重定向，每跳重新做 SSRF 校验（防 DNS rebinding 简化处理） */
async function fetchWithRedirects(
  url: URL,
  signal: AbortSignal | undefined,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  let current = url;
  for (let redirects = 0; ; redirects++) {
    await assertPublicHostname(current.hostname);
    const response = await fetchFn(current, {
      redirect: "manual",
      signal: withTimeout(signal, TIMEOUT_MS),
      headers: { "user-agent": "Mozilla/5.0 (compatible; pi-web-fetch/1.0)" },
    });
    const location = response.headers.get("location");
    if (location && response.status >= 300 && response.status < 400) {
      if (redirects >= MAX_REDIRECTS) {
        throw new Error(`重定向次数超过上限 (${MAX_REDIRECTS})`);
      }
      current = new URL(location, current);
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new Error(`不支持的协议: ${current.protocol}`);
      }
      continue;
    }
    return response;
  }
}

export async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`无效的 URL: ${url}`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`只支持 http/https，收到: ${target.protocol}`);
  }

  const response = await fetchWithRedirects(target, signal);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  const category = classifyContentType(contentType);
  if (category === null) {
    throw new Error(`不支持的内容类型: ${contentType || "unknown"}`);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BYTES) {
    throw new Error(`页面过大 (${declaredLength} bytes)，上限 ${MAX_BYTES}`);
  }

  let body = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = (await reader.read()) as { done: boolean; value: Uint8Array };
      if (chunk.done) break;
      body += decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(body, "utf8") > MAX_BYTES) {
        throw new Error(`页面过大，上限 ${MAX_BYTES} bytes`);
      }
    }
    body += decoder.decode();
  }

  if (category === "html") {
    return extractMarkdown(body, response.url);
  }
  // JSON / XML / text/*：原样返回
  return { url: response.url, title: response.url, markdown: body.trim() };
}

/** 按 mime 主体分类响应；html 走 readability，其余文本类原样返回 */
function classifyContentType(contentType: string): "html" | "text" | null {
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json" || mime.endsWith("+json")) return "text";
  if (mime === "application/xml" || mime.endsWith("+xml")) return "text";
  return null;
}

/** 提取用到的 document 最小接口（linkedom 类型是 any，显式标注避免 unsafe） */
interface ParsedDocument {
  title: string | null;
  body: { textContent: string | null } | null;
  querySelectorAll(selector: string): readonly {
    id: string | null;
    removeAttribute(name: string): void;
  }[];
}

/**
 * React 19 流式 SSR 把尚未 hydrate 的正文放在 <div hidden id="S:N"> 里暂存，
 * 客户端接管后才移除 hidden。静态抓取时先解除，否则 readability 会把它当
 * 隐藏内容丢弃，只留下 Suspense fallback（如 "Loading..."）。
 */
function unshadowReactStreaming(document: ParsedDocument): void {
  for (const el of document.querySelectorAll("[hidden]")) {
    if (/^S:\d+$/.test(el.id ?? "")) el.removeAttribute("hidden");
  }
}

/** 从 HTML 提取标题 + 正文 markdown（readability 主内容 → turndown） */
export function extractMarkdown(html: string, sourceUrl: string): FetchedPage {
  const parsed = parseHTML(html) as { document: ParsedDocument };
  const document = parsed.document;
  unshadowReactStreaming(document);
  // tsconfig 无 DOM lib；Readability 构造参数声明为 DOM Document，运行时只用到
  // linkedom document 的兼容方法，cast 桥接即可
  const article = new Readability(parsed.document).parse();
  let title = article?.title ?? document.title?.trim() ?? sourceUrl;
  if (typeof title !== "string" || title.length === 0) title = sourceUrl;
  let body = article?.content;
  if (!body || body.length === 0) {
    body = document.body?.textContent ?? "";
  }
  if (typeof body !== "string" || body.trim().length < MIN_USEFUL_CONTENT) {
    throw new Error("页面没有可提取的正文内容");
  }
  const markdown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  })
    .turndown(body)
    .trim();
  return { url: sourceUrl, title, markdown };
}
