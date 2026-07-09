import http from "http";
import https from "https";
import net from "net";
import { certificateAuthority } from "./ca";
import { URL } from "url";
import { vault } from "./vault";
import { appendAudit } from "./audit";
import { matchProvider, type Provider } from "./providers";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

interface ProxyConfig {
  port: number;
  host: string;
  rejectUnauthorized: boolean;
}

interface SubstitutionResult {
  headers: http.IncomingHttpHeaders;
  secretNames: string[];
  missingSecrets: string[];
}

const SCANNED_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);
const PLACEHOLDER_RE = /\{\{secret:([A-Za-z0-9_.-]+)\}\}/g;

export class ProxyServer {
  private server: http.Server | null = null;
  private config: ProxyConfig;

  constructor(config: Partial<ProxyConfig> = {}) {
    this.config = {
      port: config.port ?? 8888,
      host: config.host || "127.0.0.1",
      rejectUnauthorized: config.rejectUnauthorized ?? true,
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

      server.on("connect", async (req, socket, head) => {
        await this.handleConnect(req, socket, head);
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

      server.listen(this.config.port, this.config.host, async () => {
        this.server = server;
        const address = this.server.address();
        if (address && typeof address === "object") {
          this.config.port = address.port;
        }
        console.log(`AgentPass proxy running on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqUrl = req.url || "";
    const isAbsolute = reqUrl.startsWith("http://") || reqUrl.startsWith("https://");

    if (!isAbsolute) {
      if (reqUrl === "/_/health" || reqUrl.startsWith("/_/health?")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const match = matchProvider(reqUrl.split("?")[0] || "");
      if (!match) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found", path: reqUrl }));
        return;
      }
      const queryIndex = reqUrl.indexOf("?");
      const upstreamPath = match.rest + (queryIndex >= 0 ? reqUrl.slice(queryIndex) : "");
      return this.handleProviderRoute(req, res, match.provider, upstreamPath);
    }

    return this.handleForwardProxy(req, res, reqUrl);
  }

  private async handleForwardProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetUrl: string
  ): Promise<void> {
    const started = Date.now();
    const url = new URL(targetUrl);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;
    const destination = `${url.hostname}:${url.port || (isHttps ? 443 : 80)}`;

    const substitution = await substitutePlaceholders(req.headers, (name) => vault.get(name));
    if (substitution.missingSecrets.length > 0) {
      const error = `Missing secret: ${substitution.missingSecrets.join(", ")}`;
      appendAudit({
        method: req.method || "GET",
        destination,
        secretNames: substitution.secretNames,
        statusCode: 400,
        durationMs: Date.now() - started,
        error,
      });
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(error);
      return;
    }

    const proxyReq = client.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: req.method,
        headers: substitution.headers,
        rejectUnauthorized: this.config.rejectUnauthorized,
      },
      (proxyRes) => {
        appendAudit({
          method: req.method || "GET",
          destination,
          secretNames: substitution.secretNames,
          statusCode: proxyRes.statusCode,
          durationMs: Date.now() - started,
        });
        res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      }
    );

    proxyReq.on("error", (err) => {
      console.error("Proxy error:", err.message);
      appendAudit({
        method: req.method || "GET",
        destination,
        secretNames: substitution.secretNames,
        statusCode: 502,
        durationMs: Date.now() - started,
        error: err.message,
      });
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy Error: ${err.message}`);
    });

    req.pipe(proxyReq, { end: true });
  }

  private async handleProviderRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    provider: Provider,
    upstreamPath: string
  ): Promise<void> {
    const started = Date.now();
    const destination = `${provider.upstream.host}${upstreamPath}`;

    let pool: { name: string; value: string }[];
    try {
      pool = await vault.getPool(provider.name);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "vault_unavailable", message }));
      return;
    }

    if (pool.length === 0) {
      appendAudit({
        method: req.method || "GET",
        destination,
        secretNames: [],
        statusCode: 503,
        durationMs: Date.now() - started,
        error: `no keys configured for provider ${provider.name}`,
      });
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no_keys", provider: provider.name }));
      return;
    }

    const body = await readBody(req);
    const client = provider.upstream.protocol === "https" ? https : http;
    const upstreamPort =
      provider.upstream.port || (provider.upstream.protocol === "https" ? 443 : 80);

    let lastStatus = 502;
    let lastHeaders: http.IncomingHttpHeaders | null = null;
    let lastBody: Buffer | null = null;

    let attempts = 0;                  // <-- ADD THIS
    const maxAttempts = pool.length;

    for (const { name, value } of pool) {
      attempts++;
      const headers = sanitizeRequestHeaders(req.headers, provider.upstream.host);
      provider.applyAuth(headers, value);

      const result = await sendUpstream(client, {
        hostname: provider.upstream.host,
        port: upstreamPort,
        path: upstreamPath,
        method: req.method || "GET",
        headers,
        body,
        rejectUnauthorized: this.config.rejectUnauthorized,
      });

      if ("error" in result) {
        appendAudit({
          method: req.method || "GET",
          destination,
          secretNames: [name],
          statusCode: 502,
          durationMs: Date.now() - started,
          error: result.error,
        });
        lastStatus = 502;
        lastHeaders = null;
        lastBody = Buffer.from(result.error);
        continue;
      }

      appendAudit({
        method: req.method || "GET",
        destination,
        secretNames: [name],
        statusCode: result.status,
        durationMs: Date.now() - started,
      });

      lastStatus = result.status;
      lastHeaders = result.headers;
      lastBody = result.body;

      if (provider.isRateLimit(result.status) || provider.isAuthError(result.status)) {
        if (attempts >= maxAttempts) {
          console.warn(`[AgentPass] All ${maxAttempts} keys exhausted for ${provider.name}. Returning last error.`);
          writeUpstreamResponse(res, result.status, result.headers, result.body);
          return;
        }
        continue;
      }

      writeUpstreamResponse(res, result.status, result.headers, result.body);
      return;
    }

    if (lastHeaders) {
      writeUpstreamResponse(res, lastStatus, lastHeaders, lastBody ?? Buffer.alloc(0));
    } else {
      res.writeHead(lastStatus || 503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "all_keys_exhausted",
          provider: provider.name,
          lastStatus,
        })
      );
    }
  }

  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: NodeJS.ReadWriteStream,
    head: Buffer
  ): Promise<void> {
    const started = Date.now();
    const [hostname, portText] = (req.url || "").split(":");
    const port = Number(portText || "443");
    if (!hostname || !Number.isFinite(port)) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.end();
      return;
    }

    try {
      if (head.length > 0) clientSocket.unshift(head);

      const hostPair = certificateAuthority.getHostCertificate(hostname);
      const caPair = certificateAuthority.ensureCa();
      const certChain = `${hostPair.cert}\n${caPair.cert}`;

      const httpsServer = https.createServer({ key: hostPair.key, cert: certChain }, async (req, res) => {
        const startedReq = Date.now();
        try {
          const substitution = await substitutePlaceholders(req.headers, (n) => vault.get(n));
          if (substitution.missingSecrets.length > 0) {
            appendAudit({
              method: req.method || "GET",
              destination: `${hostname}:${port}`,
              secretNames: substitution.secretNames,
              statusCode: 400,
              durationMs: Date.now() - startedReq,
              error: `missing_secrets:${substitution.missingSecrets.join(",")}`,
            });
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Missing secrets\n");
            return;
          }

          const upstreamReq = https.request(
            {
              hostname,
              port,
              path: req.url || "/",
              method: req.method,
              headers: substitution.headers,
              rejectUnauthorized: this.config.rejectUnauthorized,
            },
            (upstreamRes) => {
              appendAudit({
                method: req.method || "GET",
                destination: `${hostname}:${port}`,
                secretNames: substitution.secretNames,
                statusCode: upstreamRes.statusCode,
                durationMs: Date.now() - startedReq,
              });
              res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
              upstreamRes.pipe(res, { end: true });
            }
          );

          upstreamReq.on("error", (err) => {
            appendAudit({
              method: req.method || "GET",
              destination: `${hostname}:${port}`,
              secretNames: substitution.secretNames,
              statusCode: 502,
              durationMs: Date.now() - startedReq,
              error: err.message,
            });
            try {
              res.writeHead(502, { "Content-Type": "text/plain" });
              res.end(`Proxy Error: ${err.message}`);
            } catch { }
          });

          req.on("error", () => {
            try { upstreamReq.destroy(); } catch {}
          });

          req.pipe(upstreamReq, { end: true });
        } catch (err: any) {
          console.error(`[AgentPass] CONNECT handler error for ${hostname}:`, err?.message ?? err);
          appendAudit({
            method: req.method || "GET",
            destination: `${hostname}:${port}`,
            secretNames: [],
            statusCode: 502,
            durationMs: Date.now() - startedReq,
            error: err?.message ?? String(err),
          });
          try {
            res.writeHead(502, { "Content-Type": "text/plain" });
            res.end("Proxy Error\n");
          } catch { }
        }
      });

      const onError = (err: Error) => {
        appendAudit({
          method: "CONNECT",
          destination: `${hostname}:${port}`,
          secretNames: [],
          statusCode: 502,
          durationMs: Date.now() - started,
          error: err.message,
        });
        console.error(`[AgentPass] CONNECT error for ${hostname}:${port}:`, err.message);
        try { clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { }
        try { clientSocket.end(); } catch { }
      };

      httpsServer.on("error", onError);

      httpsServer.listen(0, "127.0.0.1", () => {
        const addr = httpsServer.address();
        const listenPort = typeof addr === "object" && addr ? addr.port : 0;
        const mitmSocket = net.connect(listenPort, "127.0.0.1", () => {
          try { clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); } catch { }

          appendAudit({
            method: "CONNECT",
            destination: `${hostname}:${port}`,
            secretNames: [],
            statusCode: 200,
            durationMs: Date.now() - started,
          });
          clientSocket.pipe(mitmSocket);
          mitmSocket.pipe(clientSocket);
        });

        mitmSocket.on("error", (err) => {
          onError(err as Error);
          try { httpsServer.close(); } catch { }
        });

        mitmSocket.on("close", () => {
          try { httpsServer.close(); } catch { }
        });

        clientSocket.on("error", (err) => {
          try { httpsServer.close(); } catch { }
        });

        clientSocket.on("close", () => {
          try { httpsServer.close(); } catch { }
        });
      });
    } catch (err: any) {
      appendAudit({
        method: "CONNECT",
        destination: `${hostname}:${port}`,
        secretNames: [],
        statusCode: 502,
        durationMs: Date.now() - started,
        error: err?.message ?? String(err),
      });
      try {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.end();
      } catch { }
    }
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          console.log("\nProxy stopped");
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
    const address = this.server?.address();
    if (address && typeof address === "object") {
      return address.port;
    }
    return this.config.port;
  }

  getPort(): number {
    return this.port();
  }
}

export const proxy = new ProxyServer();

async function replacePlaceholders(
  value: string,
  resolver: (name: string) => Promise<string | null>
): Promise<{ value: string; found: string[]; missing: string[] }> {
  const found: string[] = [];
  const missing: string[] = [];
  let output = value;
  const matches = [...value.matchAll(PLACEHOLDER_RE)];

  for (const match of matches) {
    const placeholder = match[0];
    const name = match[1];
    if (!name) continue;

    found.push(name);
    const secret = await resolver(name);
    if (!secret) {
      missing.push(name);
      continue;
    }
    output = output.split(placeholder).join(secret);
  }

  return { value: output, found, missing };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sanitizeRequestHeaders(
  headers: http.IncomingHttpHeaders,
  upstreamHost: string
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "host") continue;
    if (value !== undefined) out[key] = value as string | string[];
  }
  out["host"] = upstreamHost;
  return out;
}

interface UpstreamSuccess {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}
interface UpstreamError {
  error: string;
}

function sendUpstream(
  client: typeof http | typeof https,
  opts: {
    hostname: string;
    port: number;
    path: string;
    method: string;
    headers: Record<string, string | string[]>;
    body: Buffer;
    rejectUnauthorized: boolean;
  }
): Promise<UpstreamSuccess | UpstreamError> {
  return new Promise((resolve) => {
    const req = client.request(
      {
        hostname: opts.hostname,
        port: opts.port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers,
        rejectUnauthorized: opts.rejectUnauthorized,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 502,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on("error", (err) => resolve({ error: err.message }));
      }
    );
    req.on("error", (err) => resolve({ error: err.message }));
    if (opts.body.length > 0) req.write(opts.body);
    req.end();
  });
}

function writeUpstreamResponse(
  res: http.ServerResponse,
  status: number,
  headers: http.IncomingHttpHeaders,
  body: Buffer
): void {
  const responseHeaders: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "content-length") continue;
    if (value !== undefined) responseHeaders[key] = value;
  }
  responseHeaders["content-length"] = body.length;
  res.writeHead(status, responseHeaders);
  res.end(body);
}

export async function substitutePlaceholders(
  headers: http.IncomingHttpHeaders,
  resolver: (name: string) => Promise<string | null>
): Promise<SubstitutionResult> {
  const nextHeaders: http.IncomingHttpHeaders = { ...headers };
  const secretNames = new Set<string>();
  const missingSecrets = new Set<string>();

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (!SCANNED_HEADERS.has(headerName.toLowerCase()) || typeof headerValue !== "string") {
      continue;
    }

    const replacement = await replacePlaceholders(headerValue, resolver);
    replacement.found.forEach((name) => secretNames.add(name));
    replacement.missing.forEach((name) => missingSecrets.add(name));
    nextHeaders[headerName] = replacement.value;
  }

  return {
    headers: nextHeaders,
    secretNames: [...secretNames],
    missingSecrets: [...missingSecrets],
  };
}
