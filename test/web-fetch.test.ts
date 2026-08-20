/**
 * Tests for the web fetch extension:
 * - isPrivateAddress: private/reserved IP classification
 * - assertPublicHostname: DNS-based SSRF blocking
 * - extractMarkdown: readability extraction to markdown
 * - fetchPage: protocol checks, redirect handling, content-type gate
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertPublicHostname,
  extractMarkdown,
  fetchPage,
  isPrivateAddress,
} from "../src/web/fetch.js";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));

afterEach(() => {
  vi.unstubAllGlobals();
  lookup.mockReset();
});

describe("isPrivateAddress", () => {
  it("blocks private and reserved IPv4 ranges", () => {
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "198.18.0.1",
      "192.0.0.1",
      "224.0.0.1",
      "240.0.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "93.184.216.34"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("blocks private and reserved IPv6", () => {
    for (const ip of [
      "::",
      "::1",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:192.168.1.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6", () => {
    for (const ip of ["2606:4700::6810:84e5", "2001:4860:4860::8888"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("rejects non-IP strings", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
});

describe("assertPublicHostname", () => {
  it("passes when all addresses are public", async () => {
    lookup.mockResolvedValue([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
    await expect(assertPublicHostname("example.com")).resolves.toBeUndefined();
  });

  it("throws when any address is private", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    await expect(assertPublicHostname("evil.example")).rejects.toThrow("内网地址");
  });

  it("throws when DNS lookup fails", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicHostname("nope.example")).rejects.toThrow("域名解析失败");
  });
});

const HTML_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>Example Article</title></head>
<body>
<nav>navigation junk that readability should ignore</nav>
<article>
<h1>Main Heading</h1>
<p>This is a meaningful paragraph with enough text that the readability algorithm
will consider the article container a candidate main content region. It contains
several sentences of reasonably substantial prose so the extraction does not bail
out early due to insufficient content.</p>
<ul>
<li>First list item describing a point</li>
<li>Second list item describing another point</li>
</ul>
<p>A closing paragraph that wraps up the article with additional detail about the
topic under discussion, giving the extractor a bit more signal to work with.</p>
</article>
<footer>footer junk</footer>
</body>
</html>`;

describe("extractMarkdown", () => {
  it("extracts title and markdown body", () => {
    const page = extractMarkdown(HTML_FIXTURE, "https://example.com/article");
    expect(page.title).toBe("Example Article");
    expect(page.markdown).toContain("Main Heading");
    expect(page.markdown).toContain("First list item");
    expect(page.markdown).not.toContain("navigation junk");
  });

  it("throws on pages with too little content", () => {
    expect(() =>
      extractMarkdown(
        "<html><head><title>t</title></head><body><p>only a short line</p></body></html>",
        "https://x",
      ),
    ).toThrow("没有可提取的正文");
  });

  it("throws when the page has no usable content", () => {
    expect(() => extractMarkdown("<html><head></head><body></body></html>", "https://x")).toThrow(
      "没有可提取的正文",
    );
  });
});

describe("fetchPage", () => {
  it("rejects non-http(s) protocols", async () => {
    await expect(fetchPage("file:///etc/passwd")).rejects.toThrow("只支持 http/https");
  });

  it("rejects invalid URLs", async () => {
    await expect(fetchPage("not a url")).rejects.toThrow("无效的 URL");
  });

  it("blocks hosts resolving to private IPs", async () => {
    lookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    await expect(fetchPage("https://internal.example/page")).rejects.toThrow("内网地址");
  });

  it("rejects non-HTML content types", async () => {
    lookup.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("pdf", { status: 200, headers: { "content-type": "application/pdf" } }),
      ),
    );
    await expect(fetchPage("https://example.com/file.pdf")).rejects.toThrow("不支持的内容类型");
  });

  it("returns JSON responses verbatim", async () => {
    lookup.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
    const json = JSON.stringify({ status: "ok", count: 3, items: ["a", "b"] });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(json, {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8; api-version=6.0" },
          }),
      ),
    );
    const page = await fetchPage("https://example.com/api/data");
    expect(page.markdown).toBe(json);
  });

  it("returns plain text verbatim", async () => {
    lookup.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("hello world\nsecond line", {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      ),
    );
    const page = await fetchPage("https://example.com/status.txt");
    expect(page.markdown).toBe("hello world\nsecond line");
  });

  it("fetches HTML and extracts markdown, re-validating redirects", async () => {
    lookup
      .mockResolvedValueOnce([{ address: "1.2.3.4", family: 4 }])
      .mockResolvedValueOnce([{ address: "5.6.7.8", family: 4 }]);
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "https://short.example/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://target.example/page" },
        });
      }
      return new Response(HTML_FIXTURE, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchPage("https://short.example/");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://target.example/page");
    expect(page.title).toBe("Example Article");
    expect(page.markdown).toContain("Main Heading");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("rejects excessive redirects", async () => {
    lookup.mockResolvedValue([{ address: "1.2.3.4", family: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = typeof input === "string" ? input : String(input);
        return new Response(null, { status: 302, headers: { location: `${url}next` } });
      }),
    );
    await expect(fetchPage("https://loop.example/")).rejects.toThrow("重定向次数超过上限");
  });
});
