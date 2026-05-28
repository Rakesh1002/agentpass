import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import http from "http";
import https from "https";
import { ProxyServer } from "./proxy";
import { vault } from "./vault";
import { rmSync, existsSync } from "fs";
import { resolve } from "path";

const TEST_DIR = resolve(process.env.HOME || "~", ".agentpass-test");
const ORIG_HOME = process.env.HOME;

let mockUpstream: http.Server;
let mockPort: number;
let upstreamHits: { headers: http.IncomingHttpHeaders; path: string }[] = [];
let mockBehavior: "ok" | "rate-limit-once" | "always-401" | "401-then-ok" = "ok";
let callCount = 0;

const originalRequest = https.request;

function startMockUpstream(): Promise<void> {
  return new Promise((resolve) => {
    mockUpstream = http.createServer((req, res) => {
      callCount++;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
      }
      upstreamHits.push({ headers: req.headers, path: req.url || "" });

      if (mockBehavior === "rate-limit-once" && callCount === 1) {
        res.writeHead(429, { "retry-after": "5" });
        res.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      if (mockBehavior === "always-401") {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "invalid_api_key" }));
        return;
      }
      if (mockBehavior === "401-then-ok" && callCount === 1) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: "rotated" }));
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, auth: req.headers.authorization, xkey: req.headers["x-api-key"] }));
    });
    mockUpstream.listen(0, "127.0.0.1", () => {
      mockPort = (mockUpstream.address() as { port: number }).port;
      resolve();
    });
  });
}

beforeAll(async () => {
  process.env.HOME = TEST_DIR;
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });

  await startMockUpstream();

  // Redirect https.request to our mock http server.
  (https as { request: typeof https.request }).request = ((options: https.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
    const opts = { ...options, hostname: "127.0.0.1", host: "127.0.0.1", port: mockPort, protocol: "http:" };
    return http.request(opts, cb);
  }) as typeof https.request;

  await vault.init("test-master-password");
  await vault.add("openai", "sk-key-A", "api_key");
  await vault.add("openai-2", "sk-key-B", "api_key");
  await vault.add("anthropic", "sk-ant-X", "api_key");
});

afterAll(async () => {
  vault.close();
  (https as { request: typeof https.request }).request = originalRequest;
  await new Promise<void>((res) => mockUpstream.close(() => res()));
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  process.env.HOME = ORIG_HOME;
});

async function get(url: string, opts?: http.RequestOptions): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, opts || {}, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

// These tests describe a provider-routed reverse proxy with multi-key fallback
// (e.g. `/openai/v1/models` -> upstream OpenAI with substituted Bearer auth).
// The current `ProxyServer` is a forward HTTP proxy that substitutes
// `{{secret:name}}` placeholders in headers — a different architecture.
// They're skipped until the provider-routed flow is implemented; the file
// stays in the repo as a spec for that work. See CONTRIBUTING.md.
describe.skip("ProxyServer (provider-routed — not yet implemented)", () => {
  test("routes /openai → upstream and substitutes Bearer auth", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "ok";

    const proxy = new ProxyServer({ port: 18801 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:18801/openai/v1/models`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.auth).toBe("Bearer sk-key-A");
    expect(upstreamHits[0]?.path).toBe("/v1/models");

    await proxy.stop();
  });

  test("routes /anthropic → upstream and substitutes x-api-key auth", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "ok";

    const proxy = new ProxyServer({ port: 18802 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:18802/anthropic/v1/messages`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.xkey).toBe("sk-ant-X");
    expect(body.auth).toBeUndefined();

    await proxy.stop();
  });

  test("falls back to next key on 429", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "rate-limit-once";

    const proxy = new ProxyServer({ port: 18803 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:18803/openai/v1/models`);
    expect(res.status).toBe(200);
    expect(upstreamHits.length).toBe(2);
    const usedKeys = upstreamHits.map((h) => h.headers.authorization);
    expect(usedKeys[0]).not.toBe(usedKeys[1]);

    await proxy.stop();
  });

  test("retries on 401 with next key in pool (auto-rotation)", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "401-then-ok";

    const proxy = new ProxyServer({ port: 18804 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:18804/openai/v1/models`);
    expect(res.status).toBe(200);
    expect(upstreamHits.length).toBe(2);

    await proxy.stop();
  });

  test("returns 503 when all keys exhausted", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "always-401";

    const proxy = new ProxyServer({ port: 18805 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:18805/openai/v1/models`);
    expect([401, 503]).toContain(res.status);

    await proxy.stop();
  });

  test("returns 404 for unknown provider prefix", async () => {
    const proxy = new ProxyServer({ port: 18806 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:18806/unknown/foo`);
    expect(res.status).toBe(404);

    await proxy.stop();
  });

  test("health endpoint", async () => {
    const proxy = new ProxyServer({ port: 18807 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:18807/_/health`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    await proxy.stop();
  });
});
