import http from "http";
import https from "https";
import { vault } from "./vault";
import { matchProvider, type Provider } from "./providers";

interface ProxyConfig {
  port: number;
  host: string;
}

interface KeyState {
  cooldownUntil: number;
  consecutiveAuthFailures: number;
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function fingerprint(key: string): string {
  return key.slice(-8);
}

function pickKey(
  pool: { name: string; value: string }[],
  state: Map<string, KeyState>,
  cursor: { i: number }
): { name: string; value: string } | null {
  if (pool.length === 0) return null;
  const now = Date.now();
  for (let attempt = 0; attempt < pool.length; attempt++) {
    const idx = (cursor.i + attempt) % pool.length;
    const candidate = pool[idx];
    if (!candidate) continue;
    const s = state.get(candidate.value);
    if (!s || s.cooldownUntil <= now) {
      cursor.i = (idx + 1) % pool.length;
      return candidate;
    }
  }
  return null;
}

function forwardRequest(
  provider: Provider,
  upstreamPath: string,
  method: string,
  headers: Record<string, string | string[]>,
  bodyChunks: Buffer[]
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: provider.upstream.host,
        port: provider.upstream.port || 443,
        path: upstreamPath,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (bodyChunks.length > 0) req.write(Buffer.concat(bodyChunks));
    req.end();
  });
}

export class ProxyServer {
  private server: http.Server | null = null;
  private config: ProxyConfig;
  private keyState = new Map<string, KeyState>();
  private cursors = new Map<string, { i: number }>();

  constructor(config: Partial<ProxyConfig> = {}) {
    this.config = {
      port: config.port || 8888,
      host: config.host || "127.0.0.1",
    };
  }

  async start(): Promise<void> {
    if (this.server) throw new Error("Proxy already running");

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error("Proxy error:", err);
          if (!res.headersSent) {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end(`Proxy Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(`Port ${this.config.port} in use, trying ${this.config.port + 1}`);
          this.config.port++;
          server.close();
          this.start().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });

      server.listen(this.config.port, this.config.host, () => {
        this.server = server;
        console.log(
          `🔐 AgentPass proxy listening on http://${this.config.host}:${this.config.port}`
        );
        for (const p of ["openai", "anthropic", "groq", "openrouter"]) {
          console.log(`   /${p}/* → upstream`);
        }
        resolve();
      });
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const reqPath = req.url || "/";

    if (reqPath === "/_/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const matched = matchProvider(reqPath);
    if (!matched) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "no provider matched",
          hint: "use /openai, /anthropic, /groq, or /openrouter prefix",
        })
      );
      return;
    }

    const { provider, rest } = matched;
    const pool = await vault.getPool(provider.name);
    if (pool.length === 0) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: `no key in vault for provider "${provider.name}"`,
          hint: `run: agentpass add ${provider.name} <api-key>`,
        })
      );
      return;
    }

    const bodyChunks: Buffer[] = [];
    for await (const chunk of req as AsyncIterable<Buffer>) bodyChunks.push(chunk);

    const baseHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === "authorization" || k.toLowerCase() === "x-api-key") continue;
      baseHeaders[k] = v as string | string[];
    }
    baseHeaders["host"] = provider.upstream.host;

    if (!this.cursors.has(provider.name)) this.cursors.set(provider.name, { i: 0 });
    const cursor = this.cursors.get(provider.name)!;

    let lastResponse: {
      status: number;
      headers: http.IncomingHttpHeaders;
      body: Buffer;
    } | null = null;

    const triedKeys = new Set<string>();
    const maxAttempts = Math.min(pool.length, 4);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = pickKey(pool, this.keyState, cursor);
      if (!key || triedKeys.has(key.value)) break;
      triedKeys.add(key.value);

      const headers: Record<string, string | string[]> = { ...baseHeaders };
      provider.applyAuth(headers as Record<string, string | string[] | undefined>, key.value);

      const upstreamPath = rest === "/" ? "/" : rest;
      const upstream = await forwardRequest(
        provider,
        upstreamPath,
        req.method || "GET",
        headers,
        bodyChunks
      );
      lastResponse = upstream;

      if (provider.isRateLimit(upstream.status)) {
        const retryAfter = parseInt(
          (upstream.headers["retry-after"] as string) || "60",
          10
        );
        const cd = Date.now() + Math.min(Math.max(retryAfter, 5), 600) * 1000;
        this.keyState.set(key.value, {
          cooldownUntil: cd,
          consecutiveAuthFailures: 0,
        });
        console.warn(
          `[${provider.name}] key …${fingerprint(key.value)} hit ${upstream.status}, cooldown ${retryAfter}s, falling over`
        );
        continue;
      }

      if (provider.isAuthError(upstream.status)) {
        const prev = this.keyState.get(key.value);
        const fails = (prev?.consecutiveAuthFailures || 0) + 1;
        this.keyState.set(key.value, {
          cooldownUntil: fails >= 2 ? Date.now() + 24 * 3600 * 1000 : 0,
          consecutiveAuthFailures: fails,
        });
        console.warn(
          `[${provider.name}] key …${fingerprint(key.value)} got 401 (rotated?), retrying with next key`
        );
        const refreshed = await vault.getPool(provider.name);
        if (refreshed.length > pool.length) {
          pool.push(...refreshed.slice(pool.length));
        }
        continue;
      }

      this.keyState.set(key.value, { cooldownUntil: 0, consecutiveAuthFailures: 0 });
      break;
    }

    if (!lastResponse) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: `all keys for "${provider.name}" exhausted (rate-limited or invalid)`,
          tried: triedKeys.size,
        })
      );
      return;
    }

    const outHeaders: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(lastResponse.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      outHeaders[k] = v;
    }
    res.writeHead(lastResponse.status, outHeaders);
    res.end(lastResponse.body);
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          console.log("🛑 Proxy stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  port(): number {
    return this.config.port;
  }
}

export const proxy = new ProxyServer();
