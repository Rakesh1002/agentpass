import http from "http";
import https from "https";
import { URL } from "url";
import { vault } from "./vault";

interface ProxyConfig {
  port: number;
  host: string;
}

export class ProxyServer {
  private server: http.Server | null = null;
  private config: ProxyConfig;

  constructor(config: Partial<ProxyConfig> = {}) {
    this.config = {
      port: config.port || 8888,
      host: config.host || "127.0.0.1",
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
        console.log(`🔐 AgentPass proxy running on http://${this.config.host}:${this.config.port}`);
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const targetUrl = req.url?.startsWith("http") ? req.url : `https://${req.headers.host}${req.url}`;
    if (!targetUrl) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad Request");
      return;
    }

    const url = new URL(targetUrl);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    const secretValue = await this.getSecretFromHeader(req.headers.authorization);
    if (secretValue) {
      req.headers["authorization"] = secretValue;
    }

    const proxyReq = client.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      console.error("Proxy error:", err.message);
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy Error: ${err.message}`);
    });

    req.pipe(proxyReq, { end: true });
  }

  private async getSecretFromHeader(authHeader?: string): Promise<string | null> {
    if (!authHeader) return null;

    const match = authHeader.match(/\{\{secret:(\w+)\}\}/);
    if (!match) return null;

    const secretName = match[1];
    const secret = await vault.get(secretName);

    if (!secret) {
      console.warn(`Secret "${secretName}" not found in vault`);
      return null;
    }

    if (match[0].includes("Bearer")) {
      return `Bearer ${secret}`;
    }
    return secret;
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
}

export const proxy = new ProxyServer();