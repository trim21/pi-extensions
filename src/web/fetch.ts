/**
 * `web_fetch` 工具：抓取 URL 并提取正文为 markdown，或按 `output_path` 原样落盘。
 *
 * SSRF 防护：DNS 预解析 + 拒绝私有/保留地址 + 每跳重定向重新校验，
 * 防止把 agent 变成内网探测口。正文提取用 readability 主内容算法。
 *
 * 出网走 `src/lib/proxy.ts` 的代理层（~/.pi/agent/proxy.json，回退 HTTPS_PROXY 等环境
 * 变量）：Node 的全局 fetch 不认代理环境变量，GitHub 的用户附件、release 资产这类只在
 * 代理可达的 host 上，必须从这里挂出去，否则沙箱内一律 fetch failed。
 *
 * 本文件是独立扩展入口（见 package.json 的 pi.extensions），可在配置里单独禁用。
 */
import { lookup } from "node:dns/promises";
import { mkdir, open, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Type } from "typebox";

import { resolvePathArg } from "../lib/path.js";
import { createHttpProxy } from "../lib/proxy.js";
import { createRequestPolicy } from "../lib/request-policy.js";
import { guardWriteAccess } from "../lib/write-guard.js";

const httpProxy = createHttpProxy();

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 5 * 1024 * 1024;
/** 落盘模式的上限：附件、镜像、release 资产都比网页大得多，文本模式仍用 MAX_BYTES。 */
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MIN_USEFUL_CONTENT = 200;
const MAX_MARKDOWN_BYTES = 100 * 1024;

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === 0) {
    return true; // 0.0.0.0/8
  }
  if (a === 10) {
    return true; // 10.0.0.0/8
  }
  if (a === 127) {
    return true; // 127.0.0.0/8 loopback
  }
  if (a === 169 && b === 254) {
    return true; // 169.254.0.0/16 link-local
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true; // 172.16.0.0/12
  }
  if (a === 192 && b === 168) {
    return true; // 192.168.0.0/16
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true; // 100.64.0.0/10 CGNAT
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return true; // 198.18.0.0/15 benchmarking
  }
  if (a === 192 && b === 0 && c === 0) {
    return true; // 192.0.0.0/24
  }
  return a >= 224; // 224.0.0.0/3 multicast + reserved
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") {
    return true; // unspecified / loopback
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) {
    return true; // fc00::/7 ULA
  }
  if (/^fe[89ab]/.test(lower)) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith("::ffff:")) {
    return isPrivateIpv4(lower.slice(7));
  }
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    return isPrivateIpv4(ip);
  }
  if (version === 6) {
    return isPrivateIpv6(ip);
  }
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

/** 落盘结果：最终 URL、本地路径、响应的 content-type 与写出的字节数。 */
interface SavedFile {
  url: string;
  filePath: string;
  contentType: string;
  bytes: number;
}

/** 手动跟随重定向，每跳重新做 SSRF 校验（防 DNS rebinding 简化处理）。 */
async function fetchWithRedirects(
  url: URL,
  signal: AbortSignal | undefined,
  fetchFn: typeof fetch = httpProxy.fetch,
): Promise<{ response: Response; url: URL }> {
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
    return { response, url: current };
  }
}

/** 已确认 2xx 的响应，连同手动重定向后跟踪到的最终地址。 */
interface OpenedResponse {
  response: Response;
  /** 手动重定向下 `response.url` 可能是空的，最终地址由重定向循环给出。 */
  url: string;
}

/** 校验 URL、逐跳跟随重定向、要求 2xx；响应体怎么处理由调用方决定。 */
async function openResponse(url: string, signal?: AbortSignal): Promise<OpenedResponse> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`无效的 URL: ${url}`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`只支持 http/https，收到: ${target.protocol}`);
  }

  const { response, url: finalUrl } = await fetchWithRedirects(target, signal);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return { response, url: finalUrl.href };
}

export async function fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  const { response, url: finalUrl } = await openResponse(url, signal);
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
      if (chunk.done) {
        break;
      }
      body += decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(body, "utf8") > MAX_BYTES) {
        throw new Error(`页面过大，上限 ${MAX_BYTES} bytes`);
      }
    }
    body += decoder.decode();
  }

  if (category === "html") {
    return extractMarkdown(body, finalUrl);
  }
  // JSON / XML / text/*：原样返回
  return { url: finalUrl, title: finalUrl, markdown: body.trim() };
}

/**
 * 把响应体原样写进 `filePath`（二进制安全：不做 content-type 白名单、不解码、不转换），
 * 用于 GitHub 用户附件、release 资产这类不能当正文读的下载。
 * 任何一步失败都会删掉半成品，不留下看着完整其实截断的文件。
 */
export async function saveUrlToFile(
  url: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<SavedFile> {
  const { response, url: finalUrl } = await openResponse(url, signal);

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_FILE_BYTES) {
    throw new Error(`文件过大 (${declaredLength} bytes)，上限 ${MAX_FILE_BYTES}`);
  }

  await mkdir(dirname(filePath), { recursive: true });
  const handle = await open(filePath, "w");
  let bytes = 0;
  try {
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const chunk = (await reader.read()) as { done: boolean; value: Uint8Array };
        if (chunk.done) {
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > MAX_FILE_BYTES) {
          throw new Error(`文件过大，上限 ${MAX_FILE_BYTES} bytes`);
        }
        await handle.write(chunk.value);
      }
    }
  } catch (error) {
    await handle.close();
    await rm(filePath, { force: true });
    throw error;
  }
  await handle.close();

  return {
    url: finalUrl,
    filePath,
    contentType: response.headers.get("content-type") ?? "",
    bytes,
  };
}

/** 按 mime 主体分类响应；html 走 readability，其余文本类原样返回 */
function classifyContentType(contentType: string): "html" | "text" | null {
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    return "html";
  }
  if (mime.startsWith("text/")) {
    return "text";
  }
  if (mime === "application/json" || mime.endsWith("+json")) {
    return "text";
  }
  if (mime === "application/xml" || mime.endsWith("+xml")) {
    return "text";
  }
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
    if (/^S:\d+$/.test(el.id ?? "")) {
      el.removeAttribute("hidden");
    }
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
  if (typeof title !== "string" || title.length === 0) {
    title = sourceUrl;
  }
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

function truncateMarkdown(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_MARKDOWN_BYTES) {
    return { text, truncated: false };
  }
  const bytes = Buffer.from(text, "utf8");
  const sliced = bytes.subarray(0, MAX_MARKDOWN_BYTES).toString("utf8");
  const cut = sliced.lastIndexOf("\n", sliced.length - 1);
  return { text: (cut > 0 ? sliced.slice(0, cut) : sliced) + "\n…(已截断)", truncated: true };
}

export default function webFetchTool(pi: ExtensionAPI): void {
  // 本工具是独立扩展入口（pi 给每个入口单独建 jiti 实例），自建一份非沙盒请求
  // 策略并订阅 pi.events：/bwrap-deny-request 在 bash 入口切换时会同步过来。
  const policy = createRequestPolicy(pi.events);
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a URL and return its content as markdown (HTML pages) or raw text " +
      "(JSON/XML/plain-text API responses). With output_path the body is saved to that " +
      "file verbatim instead — any content type, no extraction, no truncation — and the " +
      "result is the JSON summary {url, file_path, content_type, bytes} rather than the " +
      "content; use it for images, logs and other attachments (GitHub user-attachments " +
      "links from issue bodies, release assets, raw files). Give the file the extension " +
      "matching the response's content_type: the Read tool decides image support by " +
      "extension. Requests honour the proxy in ~/.pi/agent/proxy.json, so they reach hosts " +
      "the shell sandbox blocks. SSRF-protected: refuses private/internal addresses.",
    promptSnippet: "Fetch a web page, API response, or download a file",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to fetch" }),
      output_path: Type.Optional(
        Type.String({
          description:
            "Save the response body to this path verbatim instead of returning it (absolute, or relative to the session cwd; ~ is expanded). Parent directories are created and an existing file is overwritten.",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const destination =
        params.output_path === undefined ? undefined : resolvePathArg(ctx.cwd, params.output_path);
      // 落盘位置的审批与写文件工具同一套：工作区与 /tmp 自动放行，其余问用户。
      // 放在 try 外面，拒绝的原因（user deny）不该被改写成「抓取失败」。
      if (destination !== undefined) {
        await guardWriteAccess(ctx, {
          toolName: "web_fetch",
          absolutePath: destination,
          policy,
          signal,
        });
      }

      try {
        if (destination !== undefined) {
          const file = await saveUrlToFile(params.url, destination, signal);
          const payload = {
            url: file.url,
            file_path: file.filePath,
            content_type: file.contentType,
            bytes: file.bytes,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            details: payload,
          };
        }

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
