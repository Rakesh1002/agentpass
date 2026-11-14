import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import http from "http";
import https from "https";
import { Database } from "bun:sqlite";
import { ProxyServer } from "./proxy";
import { vault } from "./vault";
import { listAudit } from "./audit";
import { makePlaceholder } from "./placeholder";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let testHome: string;
let mockUpstream: http.Server;
let mockPort: number;
let upstreamHits: { headers: http.IncomingHttpHeaders; path: string }[] = [];
let mockBehavior: "ok" | "rate-limit-once" | "always-401" | "401-then-ok" | "sse" | "always-429" = "ok";
let retryAfterByAuth: Record<string, string> = {};
let callCount = 0;
let streamGate: Promise<void> = Promise.resolve();
let upstreamFinished = false;

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
        res.writeHead(429, { "retry-after": retryAfterByAuth[String(req.headers.authorization)] ?? "5" });
        res.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      if (mockBehavior === "always-429") {
        const retryAfter = retryAfterByAuth[String(req.headers.authorization)];
        res.writeHead(429, retryAfter ? { "retry-after": retryAfter } : {});
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
      if (mockBehavior === "sse") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        streamGate.then(() => {
          upstreamFinished = true;
          res.end("data: two\n\n");
        });
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
  testHome = mkdtempSync(join(tmpdir(), "agentpass-proxy-"));
  process.env.AGENTPASS_HOME = testHome;

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
  await vault.add("anthropic-clienta", "sk-ant-clienta", "api_key");
  await vault.add("groq", "gsk-post-only", "api_key", [{ host: "api.groq.com", methods: ["POST"] }]);
  await vault.add("openrouter", "sk-or-anywhere", "api_key", [{ host: "*" }]);
});

afterAll(async () => {
  vault.close();
  (https as { request: typeof https.request }).request = originalRequest;
  await new Promise<void>((res) => mockUpstream.close(() => res()));
  delete process.env.AGENTPASS_HOME;
  rmSync(testHome, { recursive: true, force: true });
});

async function get(
  url: string,
  opts?: http.RequestOptions
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, opts || {}, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("ProxyServer (provider-routed)", () => {
  test("routes /openai → upstream and substitutes Bearer auth", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "ok";

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
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

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:${proxy.getPort()}/anthropic/v1/messages`);
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

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
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

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
    expect(res.status).toBe(200);
    expect(upstreamHits.length).toBe(2);

    await proxy.stop();
  });

  test("returns 503 when all keys exhausted", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "always-401";

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: "all_keys_exhausted", provider: "openai", lastStatus: 401 });

    // auth failures are not cooled, so a retry tries every key again
    await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
    expect(upstreamHits).toHaveLength(4);

    await proxy.stop();
  });

  test("skips a rate-limited key until its Retry-After seconds elapse", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "rate-limit-once";
    retryAfterByAuth = { "Bearer sk-key-A": "1" };

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();
    const keysUsed = () => upstreamHits.map((h) => h.headers.authorization);

    expect((await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`)).status).toBe(200);
    expect(keysUsed()).toEqual(["Bearer sk-key-A", "Bearer sk-key-B"]);

    expect((await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`)).status).toBe(200);
    expect(keysUsed()).toEqual(["Bearer sk-key-A", "Bearer sk-key-B", "Bearer sk-key-B"]);

    await Bun.sleep(1100);
    expect((await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`)).status).toBe(200);
    expect(keysUsed()[3]).toBe("Bearer sk-key-A");

    await proxy.stop();
  });

  test("returns 429 with the soonest Retry-After when every key is cooling", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "always-429";
    retryAfterByAuth = {
      "Bearer sk-key-A": new Date(Date.now() + 20_000).toUTCString(),
      "Bearer sk-key-B": "90",
    };

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const first = await new Promise<{ status: number; retryAfter: number; body: string }>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({ status: res.statusCode || 0, retryAfter: Number(res.headers["retry-after"]), body })
          );
        })
        .on("error", reject);
    });
    expect(first.status).toBe(429);
    expect(first.retryAfter).toBeGreaterThanOrEqual(18);
    expect(first.retryAfter).toBeLessThanOrEqual(20);
    expect(JSON.parse(first.body)).toMatchObject({ error: "all_keys_cooling", provider: "openai" });
    expect(upstreamHits).toHaveLength(2);

    const second = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
    expect(second.status).toBe(429);
    expect(upstreamHits).toHaveLength(2);

    await proxy.stop();
  });

  test("cools a key for 60 seconds when Retry-After is missing", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "always-429";
    retryAfterByAuth = {};

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`, (r) => (r.resume(), resolve(r))).on("error", reject);
    });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(59);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);

    await proxy.stop();
  });

  test("cools a key for at least a second on Retry-After: 0 and answers 429", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "always-429";
    retryAfterByAuth = { "Bearer sk-key-A": "0", "Bearer sk-key-B": "0" };

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("1");
    expect(JSON.parse(res.body)).toMatchObject({ error: "all_keys_cooling" });

    await proxy.stop();
  });

  test("falls back to the 60s cooldown on a negative, malformed or past Retry-After", async () => {
    mockBehavior = "always-429";
    for (const value of ["-5", "soon", "1.5", new Date(Date.now() - 60_000).toUTCString()]) {
      upstreamHits = [];
      callCount = 0;
      retryAfterByAuth = { "Bearer sk-key-A": value, "Bearer sk-key-B": value };

      const proxy = new ProxyServer({ port: 0 });
      await proxy.start();

      const res = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
      expect(res.status).toBe(429);
      expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(59);
      expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);

      await proxy.stop();
    }
  });

  test("caps a huge or far-future Retry-After at one hour", async () => {
    mockBehavior = "always-429";
    for (const value of ["99999999999", "9".repeat(400), new Date(Date.now() + 365 * 86_400_000).toUTCString()]) {
      upstreamHits = [];
      callCount = 0;
      retryAfterByAuth = { "Bearer sk-key-A": value, "Bearer sk-key-B": value };

      const proxy = new ProxyServer({ port: 0 });
      await proxy.start();

      const res = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
      expect(res.status).toBe(429);
      expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(3599);
      expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(3600);

      await proxy.stop();
    }
  });

  test("returns 404 for unknown provider prefix", async () => {
    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:${proxy.getPort()}/unknown/foo`);
    expect(res.status).toBe(404);

    await proxy.stop();
  });

  test("uses the pool named by a provider placeholder and strips client auth", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "ok";

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const viaBearer = await get(`http://127.0.0.1:${proxy.getPort()}/anthropic/v1/messages`, {
      headers: { authorization: "Bearer {{secret:anthropic-clienta}}" },
    });
    expect(JSON.parse(viaBearer.body)).toEqual({ ok: true, xkey: "sk-ant-clienta" });

    const viaApiKey = await get(`http://127.0.0.1:${proxy.getPort()}/anthropic/v1/messages`, {
      headers: { "x-api-key": "{{secret:anthropic-clienta}}" },
    });
    expect(JSON.parse(viaApiKey.body).xkey).toBe("sk-ant-clienta");

    const formatPreserving = await get(`http://127.0.0.1:${proxy.getPort()}/anthropic/v1/messages`, {
      headers: { "x-api-key": makePlaceholder("anthropic-clienta", "sk-ant-api03-") },
    });
    expect(JSON.parse(formatPreserving.body).xkey).toBe("sk-ant-clienta");

    await proxy.stop();
  });

  test("refuses a placeholder naming another provider's key on a reverse route", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "ok";

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();
    const base = `http://127.0.0.1:${proxy.getPort()}`;

    const toOpenai = await get(`${base}/openai/v1/models`, { headers: { authorization: "Bearer {{secret:anthropic}}" } });
    expect(toOpenai.status).toBe(403);
    expect(JSON.parse(toOpenai.body)).toEqual({ error: "egress_blocked", secret: "anthropic", host: "api.openai.com" });
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 403, error: "egress_blocked", secretNames: ["anthropic"] });

    const toAnthropic = await get(`${base}/anthropic/v1/messages`, { headers: { "x-api-key": "{{secret:openai-2}}" } });
    expect(toAnthropic.status).toBe(403);
    expect(JSON.parse(toAnthropic.body).secret).toBe("openai-2");

    const formatPreserving = await get(`${base}/openai/v1/models`, {
      headers: { authorization: `Bearer ${makePlaceholder("anthropic", "sk-ant-api03-")}` },
    });
    expect(formatPreserving.status).toBe(403);
    expect(JSON.parse(formatPreserving.body).secret).toBe("anthropic");
    expect(upstreamHits).toHaveLength(0);

    await proxy.stop();
  });

  test("skips pool keys whose pins reject the request", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "ok";

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const blocked = await get(`http://127.0.0.1:${proxy.getPort()}/groq/v1/models`);
    expect(blocked.status).toBe(403);
    expect(JSON.parse(blocked.body)).toEqual({ error: "egress_blocked", secret: "groq", host: "api.groq.com" });
    expect(upstreamHits).toHaveLength(0);

    const allowed = await get(`http://127.0.0.1:${proxy.getPort()}/groq/v1/chat/completions`, { method: "POST" });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body).auth).toBe("Bearer gsk-post-only");

    await proxy.stop();
  });

  test("serves a pool from its intact keys and skips one whose pins were edited outside the vault", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "ok";
    const raw = new Database(join(testHome, "vault.db"));
    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();
    try {
      raw.run(`UPDATE secrets SET pins = '[{"host":"*"}]' WHERE name = 'openai'`);
      const res = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).auth).toBe("Bearer sk-key-B");
      expect(listAudit(2)[1]).toMatchObject({ statusCode: 403, error: "integrity_failed", secretNames: ["openai"] });

      raw.run(`UPDATE secrets SET pins = '[{"host":"*"}]' WHERE name = 'openai-2'`);
      const denied = await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
      expect(denied.status).toBe(403);
      expect(JSON.parse(denied.body)).toEqual({ error: "integrity_failed", secret: "openai", host: "api.openai.com" });
      expect(listAudit(1)[0]).toMatchObject({ statusCode: 403, error: "integrity_failed", secretNames: ["openai", "openai-2"] });
      expect(upstreamHits).toHaveLength(1);
    } finally {
      raw.run(`UPDATE secrets SET pins = NULL WHERE name IN ('openai', 'openai-2')`);
      raw.close();
      await proxy.stop();
    }
  });

  test("records a wildcard-pinned pool key in the audit", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "ok";

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:${proxy.getPort()}/openrouter/api/v1/models`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).auth).toBe("Bearer sk-or-anywhere");
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 200, secretNames: ["openrouter"], wildcard: ["openrouter"] });

    await get(`http://127.0.0.1:${proxy.getPort()}/openai/v1/models`);
    expect(listAudit(1)[0]?.wildcard).toBeUndefined();

    await proxy.stop();
  });

  test("tags reverse routes from a /_t/<tag> prefix and strips it before routing", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "ok";

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();
    const base = `http://127.0.0.1:${proxy.getPort()}`;

    const tagged = await get(`${base}/_t/claude%40work-1/openai/v1/models?limit=1`);
    expect(tagged.status).toBe(200);
    expect(upstreamHits[0]?.path).toBe("/v1/models?limit=1");
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 200, sessionTag: "claude@work-1" });

    for (const ignored of ["bad%20tag", "a%2Fb", "%E0%A4%A", "a".repeat(97), ""]) {
      const res = await get(`${base}/_t/${ignored}/openai/v1/models`);
      expect(res.status).toBe(200);
      expect(listAudit(1)[0]?.sessionTag).toBeUndefined();
    }
    expect(upstreamHits.map((hit) => hit.path).slice(1)).toEqual(Array(5).fill("/v1/models"));

    await proxy.stop();
  });

  test("streams upstream bytes to the client before upstream finishes", async () => {
    upstreamHits = [];
    callCount = 0;
    mockBehavior = "sse";
    upstreamFinished = false;
    let release = () => {};
    // a buffering proxy only delivers after the fallback timer ends the upstream response
    streamGate = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 1500);
    });

    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const result = await new Promise<{ firstBeforeEnd: boolean; body: string; type?: string }>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${proxy.getPort()}/anthropic/v1/messages`, (res) => {
          let body = "";
          let firstBeforeEnd: boolean | null = null;
          res.on("data", (chunk: Buffer) => {
            if (firstBeforeEnd === null) {
              firstBeforeEnd = !upstreamFinished;
              release();
            }
            body += chunk.toString("utf8");
          });
          res.on("end", () =>
            resolve({ firstBeforeEnd: firstBeforeEnd === true, body, type: res.headers["content-type"] })
          );
        })
        .on("error", reject);
    });

    expect(result.firstBeforeEnd).toBe(true);
    expect(result.body).toBe("data: one\n\ndata: two\n\n");
    expect(result.type).toBe("text/event-stream");

    await proxy.stop();
  });

  test("health endpoint", async () => {
    const proxy = new ProxyServer({ port: 0 });
    await proxy.start();

    const res = await get(`http://127.0.0.1:${proxy.getPort()}/_/health`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);

    await proxy.stop();
  });
});
