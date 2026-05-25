import http from "http";
import https from "https";
import net from "net";
import { URL } from "url";
import { vault } from "./vault";
import { appendAudit } from "./audit";

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
    if (this.server) {
      throw new Error("Proxy already running");
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });

      this.server.on("connect", async (req, socket, head) => {
        await this.handleConnect(req, socket, head);
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(`Port ${this.config.port} in use, trying ${this.config.port + 1}`);
          this.config.port++;
          this.server?.close();
          this.start().then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.config.port, this.config.host, () => {
        const address = this.server?.address();
        if (address && typeof address === "object") {
          this.config.port = address.port;
        }
        console.log(`🔐 AgentPass proxy running on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const started = Date.now();
    const targetUrl = req.url?.startsWith("http") ? req.url : `https://${req.headers.host}${req.url}`;
    if (!targetUrl) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

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

    const proxyReq = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method,
      headers: substitution.headers,
      rejectUnauthorized: this.config.rejectUnauthorized,
    }, (proxyRes) => {
      appendAudit({
        method: req.method || "GET",
        destination,
        secretNames: substitution.secretNames,
        statusCode: proxyRes.statusCode,
        durationMs: Date.now() - started,
      });
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

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

    const upstream = net.connect(port, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      appendAudit({
        method: "CONNECT",
        destination: `${hostname}:${port}`,
        secretNames: [],
        statusCode: 200,
        durationMs: Date.now() - started,
      });
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    upstream.on("error", (err) => {
      appendAudit({
        method: "CONNECT",
        destination: `${hostname}:${port}`,
        secretNames: [],
        statusCode: 502,
        durationMs: Date.now() - started,
        error: err.message,
      });
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.end(err.message);
    });
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

  getPort(): number {
    const address = this.server?.address();
    if (address && typeof address === "object") {
      return address.port;
    }
    return this.config.port;
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
