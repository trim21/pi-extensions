/**
 * Tests for the shared proxy layer (src/lib/proxy.ts): proxy.json parsing,
 * environment fallback, the variables injected into `gh` child processes, and
 * the fetch handed to octokit's `request.fetch` (and to web_fetch).
 *
 * The fetch tests run against loopback servers: a minimal HTTP proxy
 * (CONNECT tunneling, like undici's ProxyAgent expects) and a fake origin.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type RequestListener, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHttpProxy, parseProxyConfig, proxyEnvVars } from "../src/lib/proxy.js";

// 透传 mock：把 undici 模块换成普通对象，测试里才能 spyOn 替换它的 fetch
// （真实 ESM namespace 的属性不可改）。
vi.mock("undici", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
}));

interface ReceivedRequest {
  method: string;
  url: string;
  body: string;
}

interface TestServer {
  url: string;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no TCP port");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

/** Records requests then answers with a fixed JSON body. */
async function startOrigin(): Promise<TestServer & { requests: ReceivedRequest[] }> {
  const requests: ReceivedRequest[] = [];
  const server = createServer(
    collectRequest(requests, (res) => {
      res.writeHead(201, { "content-type": "application/json", "x-origin": "yes" });
      res.end(JSON.stringify({ ok: true }));
    }),
  );
  const port = await listen(server);
  return {
    requests,
    url: `http://127.0.0.1:${String(port)}`,
    close: () => closeServer(server),
  };
}

/**
 * Minimal HTTP proxy: CONNECT requests are tunneled to their target (undici's
 * ProxyAgent tunnels http and https targets alike), and every CONNECT is
 * recorded so tests can assert the traffic went through the proxy.
 */
async function startProxy(): Promise<TestServer & { connects: string[] }> {
  const connects: string[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("proxy only tunnels, it does not serve requests");
  });
  server.on("connect", (req, clientSocket, head) => {
    const target = req.url ?? "";
    connects.push(target);
    const [host, port] = target.split(":", 2);
    const upstream = netConnect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  const port = await listen(server);
  return {
    connects,
    url: `http://127.0.0.1:${String(port)}`,
    close: () => closeServer(server),
  };
}

/**
 * A proxy that records CONNECT targets and then refuses the tunnel. Used where
 * the test must not depend on the host having (or not having) network access to
 * the target host.
 */
async function startRefusingProxy(): Promise<TestServer & { connects: string[] }> {
  const connects: string[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("no tunneling");
  });
  server.on("connect", (req, socket) => {
    connects.push(req.url ?? "");
    socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  const port = await listen(server);
  return {
    connects,
    url: `http://127.0.0.1:${String(port)}`,
    close: () => closeServer(server),
  };
}

/** Buffer the request body, record the request, then hand off to `respond`. */
function collectRequest(
  requests: ReceivedRequest[],
  respond: (res: Parameters<RequestListener>[1]) => void,
): RequestListener {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString(),
      });
      respond(res);
    });
  };
}

describe("parseProxyConfig", () => {
  it("trims proxy and noProxy", () => {
    expect(parseProxyConfig({ proxy: " http://127.0.0.1:7890 ", noProxy: " localhost " })).toEqual({
      proxy: "http://127.0.0.1:7890",
      noProxy: "localhost",
    });
  });

  it("drops empty values", () => {
    expect(parseProxyConfig({ proxy: "  ", noProxy: "" })).toEqual({});
  });

  it("rejects non-string fields", () => {
    expect(() => parseProxyConfig({ proxy: 7890 })).toThrow(/proxy/);
  });
});

describe("proxyEnvVars", () => {
  it("returns nothing when no proxy is configured", () => {
    expect(proxyEnvVars({})).toEqual({});
  });

  it("sets upper and lower case variables for both schemes", () => {
    expect(proxyEnvVars({ proxy: "http://127.0.0.1:7890", noProxy: "localhost" })).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      all_proxy: "http://127.0.0.1:7890",
      NO_PROXY: "localhost",
      no_proxy: "localhost",
    });
  });
});

describe("createHttpProxy", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "proxy-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function configPath(): string {
    return join(dir, "proxy.json");
  }

  it("treats a missing config file as unconfigured", () => {
    const proxy = createHttpProxy(configPath(), {});
    expect(proxy.settings).toEqual({});
    expect(proxy.env).toEqual({});
  });

  it("reads proxy settings from the config file", async () => {
    await writeFile(configPath(), JSON.stringify({ proxy: "http://127.0.0.1:7890" }));
    const proxy = createHttpProxy(configPath(), {});
    expect(proxy.settings).toEqual({ proxy: "http://127.0.0.1:7890" });
    expect(proxy.env).toMatchObject({ HTTPS_PROXY: "http://127.0.0.1:7890" });
  });

  it("falls back to the standard environment variables", () => {
    const proxy = createHttpProxy(configPath(), {
      HTTPS_PROXY: "http://env:8080",
      NO_PROXY: "localhost",
    });
    expect(proxy.env).toMatchObject({ HTTPS_PROXY: "http://env:8080", NO_PROXY: "localhost" });
  });

  it("prefers the config file over the environment", async () => {
    await writeFile(configPath(), JSON.stringify({ proxy: "http://config:7890" }));
    const proxy = createHttpProxy(configPath(), { HTTPS_PROXY: "http://env:8080" });
    expect(proxy.env.HTTPS_PROXY).toBe("http://config:7890");
  });

  it("falls back to the environment for the fields the config leaves out", async () => {
    await writeFile(configPath(), JSON.stringify({ proxy: "http://config:7890" }));
    const proxy = createHttpProxy(configPath(), { NO_PROXY: "localhost" });
    expect(proxy.env.NO_PROXY).toBe("localhost");
  });

  // 配置在扩展加载时读一次；写错了就直接抛，让进程启动即失败而不是静默直连。
  it("throws on broken JSON", async () => {
    await writeFile(configPath(), "{not json");
    expect(() => createHttpProxy(configPath(), {})).toThrow(/proxy\.json/);
  });

  it("throws on schema violations", async () => {
    await writeFile(configPath(), JSON.stringify({ proxy: 7890 }));
    expect(() => createHttpProxy(configPath(), {})).toThrow(/proxy/);
  });

  it("throws on unsupported proxy protocols", async () => {
    await writeFile(configPath(), JSON.stringify({ proxy: "socks5://127.0.0.1:1080" }));
    expect(() => createHttpProxy(configPath(), {})).toThrow(/unsupported proxy protocol/);
  });

  it("reads the config file once, at construction", async () => {
    await writeFile(configPath(), JSON.stringify({ proxy: "http://first:1" }));
    const proxy = createHttpProxy(configPath(), {});
    expect(proxy.env.HTTPS_PROXY).toBe("http://first:1");
    await writeFile(configPath(), JSON.stringify({ proxy: "http://second:2" }));
    expect(proxy.env.HTTPS_PROXY).toBe("http://first:1");
  });
});

describe("createHttpProxy fetch", () => {
  let dir: string;
  let origin: Awaited<ReturnType<typeof startOrigin>>;
  let proxy: Awaited<ReturnType<typeof startProxy>>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "proxy-fetch-"));
    origin = await startOrigin();
    proxy = await startProxy();
  });

  afterEach(async () => {
    await origin.close();
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function configuredProxy(
    settings: Record<string, string>,
  ): Promise<ReturnType<typeof createHttpProxy>> {
    const path = join(dir, "proxy.json");
    await writeFile(path, JSON.stringify(settings));
    return createHttpProxy(path, {});
  }

  it("connects directly when no proxy is configured", async () => {
    const client = createHttpProxy(join(dir, "missing.json"), {});
    const response = await client.fetch(`${origin.url}/direct`);
    expect(response.status).toBe(201);
    expect(origin.requests[0]?.url).toBe("/direct");
    expect(proxy.connects).toEqual([]);
  });

  it("routes requests through the configured proxy", async () => {
    const client = await configuredProxy({ proxy: proxy.url });
    const response = await client.fetch(`${origin.url}/through`, {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: { "content-type": "application/json" },
    });

    expect(proxy.connects).toEqual([new URL(origin.url).host]);
    expect(response.status).toBe(201);
    expect(response.headers.get("x-origin")).toBe("yes");
    expect(response.url).toBe(`${origin.url}/through`);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(origin.requests).toEqual([
      { method: "POST", url: "/through", body: JSON.stringify({ hello: "world" }) },
    ]);
  });

  it("bypasses the proxy for noProxy hosts", async () => {
    const client = await configuredProxy({ proxy: proxy.url, noProxy: "127.0.0.1" });
    const response = await client.fetch(`${origin.url}/bypassed`);
    expect(response.status).toBe(201);
    expect(origin.requests[0]?.url).toBe("/bypassed");
    expect(proxy.connects).toEqual([]);
  });

  it("tunnels https targets through the proxy", async () => {
    // A proxy that refuses to open the tunnel: the assertion stays independent of
    // whether the test host has network access to the target.
    const refusing = await startRefusingProxy();
    try {
      const client = await configuredProxy({ proxy: refusing.url });
      await expect(client.fetch("https://api.github.com/zen")).rejects.toThrow();
      expect(refusing.connects).toEqual(["api.github.com:443"]);
    } finally {
      await refusing.close();
    }
  });

  it("honours a fetch replaced after the first request", async () => {
    const client = createHttpProxy(join(dir, "missing.json"), {});
    await client.fetch(`${origin.url}/first`);
    expect(origin.requests.map((r) => r.url)).toEqual(["/first"]);

    // Regression: caching the fetch implementation on the first call kept the
    // replacement from taking effect (the module-level httpProxy instance is
    // reused for the whole session).
    const undici = await import("undici");
    const replacement = vi.spyOn(undici, "fetch");
    replacement.mockImplementation(
      (async () => new Response("replaced")) as unknown as typeof undici.fetch,
    );
    try {
      const response = await client.fetch(`${origin.url}/second`);
      await expect(response.text()).resolves.toBe("replaced");
      expect(replacement).toHaveBeenCalledTimes(1);
      expect(origin.requests.map((r) => r.url)).toEqual(["/first"]);
    } finally {
      replacement.mockRestore();
    }
  });
});
