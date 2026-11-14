import http from "http";
import https from "https";
import net from "net";
import type { Duplex } from "stream";
import { certificateAuthority } from "./ca";
import { URL } from "url";
import { vault } from "./vault";
import { appendAudit } from "./audit";
import { matchProvider, PROVIDERS, type Provider } from "./providers";
import { egressVerdict, type Pin } from "./egress";
import {
  loadRoutingConfig,
  makeRoutingDecision,
  checkEscalationTriggers,
  isDuplicateRetry,
  nextTier,
  type RoutingConfig,
  type TaskTier,
} from "./router";
import {
  canTranslate,
  translateOpenAIToAnthropic,
  translateAnthropicToOpenAI,
  translateAnthropicResponseToOpenAI,
  translateOpenAIResponseToAnthropic,
  detectRequestFormat,
  type OpenAIRequest,
  type AnthropicRequest,
  type AnthropicResponse,
  type OpenAIResponse,
} from "./schema-translator";

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

    const egress = await this.enforceEgress(req, res, url.hostname, url.pathname, destination, started);
    if (!egress) return;
    const { wildcard } = egress;

    const substitution = await substitutePlaceholders(req.headers, egress.resolve);
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
    // RFC 9112 3.2.2: use the absolute-form authority, never the client's Host (domain fronting)
    substitution.headers.host = url.host;

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
          wildcard,
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
        wildcard,
      });
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Proxy Error: ${err.message}`);
    });

    req.pipe(proxyReq, { end: true });
  }

  // Answers 403 and returns null if any placeholder's pins reject this destination.
  private async enforceEgress(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    path: string,
    destination: string,
    started: number
  ): Promise<{ resolve: (name: string) => Promise<string | null>; wildcard: string[] } | null> {
    const method = req.method || "GET";
    const names = placeholderNames(req.headers);
    const allowed = new Set<string>();
    const wildcard: string[] = [];

    for (const name of names) {
      if (!(await vault.has(name))) continue;
      const verdict = egressVerdict(name, await vault.getPins(name), host, method, path);
      if (verdict === "wildcard") wildcard.push(name);
      if (verdict !== "deny") {
        allowed.add(name);
        continue;
      }

      appendAudit({
        method,
        destination,
        secretNames: names,
        statusCode: 403,
        durationMs: Date.now() - started,
        error: "egress_blocked",
      });
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "egress_blocked", secret: name, host }));
      return null;
    }

    // only names checked above may resolve, so a secret added mid-request cannot skip the check
    const resolve = async (name: string) => (allowed.has(name) ? vault.get(name) : null);
    return { resolve, wildcard };
  }

  private async handleProviderRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    provider: Provider,
    upstreamPath: string
  ): Promise<void> {
    const started = Date.now();
    const body = await readBody(req);

    // --- Cost-Aware Routing (Section 3.4) ---
    const routingConfig = loadRoutingConfig();
    let routedTier: TaskTier | undefined;
    let escalated = false;

    // Parse body JSON for routing decisions (non-destructive)
    let parsedBody: Record<string, unknown> | null = null;
    if (routingConfig?.enabled && body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString("utf-8")) as Record<string, unknown>;
      } catch {
        // Not JSON — skip routing, forward as-is
      }
    }

    // Check for duplicate retry escalation trigger
    if (parsedBody && routingConfig?.enabled) {
      if (
        routingConfig.escalation.trigger_on.includes("duplicate_retry") &&
        isDuplicateRetry(parsedBody)
      ) {
        // Will be handled via force-escalation below
      }
    }

    // Determine effective provider and body for this request
    let effectiveProvider = provider;
    let effectiveBody = body;
    let effectivePath = upstreamPath;
    let needsResponseTranslation = false;
    let sourceFormat: "openai" | "anthropic" | "unknown" = "unknown";

    if (parsedBody && routingConfig?.enabled) {
      const decision = makeRoutingDecision(
        routingConfig,
        parsedBody,
        provider.name,
        req.headers as Record<string, string | string[] | undefined>
      );
      routedTier = decision.tier;

      // If the router wants a different provider, redirect
      if (decision.targetProvider !== provider.name) {
        const newProvider = PROVIDERS.find((p) => p.name === decision.targetProvider);
        if (newProvider) {
          // Attempt schema translation for cross-provider routing
          if (canTranslate(parsedBody)) {
            sourceFormat = detectRequestFormat(parsedBody);
            const translated = translateRequestBody(
              parsedBody,
              sourceFormat,
              decision.targetProvider,
              decision.targetModel
            );
            if (translated) {
              effectiveProvider = newProvider;
              effectiveBody = Buffer.from(JSON.stringify(translated), "utf-8");
              effectivePath = getProviderChatPath(decision.targetProvider);
              needsResponseTranslation = true;
              console.log(
                `[AgentPass] Routed ${provider.name}→${newProvider.name} (tier: ${decision.tier}${decision.forced ? ", forced" : ""})`
              );
            }
          } else {
            // Can't translate — override model but stay on same provider
            if (parsedBody.model) {
              parsedBody.model = decision.targetModel;
              effectiveBody = Buffer.from(JSON.stringify(parsedBody), "utf-8");
            }
          }
        }
      } else {
        // Same provider — just override the model if routing table says so
        if (parsedBody.model) {
          parsedBody.model = decision.targetModel;
          effectiveBody = Buffer.from(JSON.stringify(parsedBody), "utf-8");
        }
      }
    }

    // --- Execute the request against the effective provider ---
    const result = await this.executeProviderRequest(
      req,
      effectiveProvider,
      effectivePath,
      effectiveBody,
      started,
      routedTier,
      escalated
    );

    if (!result) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no_keys", provider: effectiveProvider.name }));
      return;
    }

    // escalation and translation need the whole body; every other response streams (SSE)
    if (!routedTier) {
      sendProviderResponse(res, result);
      return;
    }
    const responseResult = await bufferProviderResponse(result);

    // --- Escalation check (Section 3.4) ---
    if (
      routingConfig?.enabled &&
      routedTier &&
      responseResult.status >= 200 &&
      responseResult.status < 300
    ) {
      let responseJson: Record<string, unknown> | null = null;
      try {
        responseJson = JSON.parse(responseResult.body.toString("utf-8")) as Record<string, unknown>;
      } catch {
        // Not JSON response — skip escalation check
      }

      if (responseJson) {
        const trigger = checkEscalationTriggers(routingConfig, responseJson, routedTier);
        const hopsRemaining = routingConfig.escalation.max_hops;

        if (trigger && hopsRemaining > 0) {
          const escalatedTier = nextTier(routedTier);
          if (escalatedTier) {
            console.log(
              `[AgentPass] Escalating ${routedTier}→${escalatedTier} (trigger: ${trigger})`
            );
            escalated = true;
            const escalationTarget = routingConfig.routing_table[escalatedTier];
            const escalationProvider =
              PROVIDERS.find((p) => p.name === escalationTarget.provider) ?? provider;

            // Re-prepare body for escalation target
            let escalationBody = body; // original body
            let escalationPath = upstreamPath;
            let escalationNeedsTranslation = false;
            let escalationSourceFormat = sourceFormat;

            if (
              escalationProvider.name !== provider.name &&
              parsedBody &&
              canTranslate(parsedBody)
            ) {
              escalationSourceFormat = detectRequestFormat(parsedBody);
              const translated = translateRequestBody(
                parsedBody,
                escalationSourceFormat,
                escalationTarget.provider,
                escalationTarget.model
              );
              if (translated) {
                escalationBody = Buffer.from(JSON.stringify(translated), "utf-8");
                escalationPath = getProviderChatPath(escalationTarget.provider);
                escalationNeedsTranslation = true;
              }
            } else if (parsedBody) {
              parsedBody.model = escalationTarget.model;
              escalationBody = Buffer.from(JSON.stringify(parsedBody), "utf-8");
            }

            const escalation = await this.executeProviderRequest(
              req,
              escalationProvider,
              escalationPath,
              escalationBody,
              started,
              escalatedTier,
              true
            );
            const escalationResult = escalation && (await bufferProviderResponse(escalation));

            if (escalationResult && escalationResult.status >= 200 && escalationResult.status < 300) {
              let finalBody = escalationResult.body;
              if (escalationNeedsTranslation) {
                finalBody = translateResponseBack(
                  escalationResult.body,
                  escalationSourceFormat,
                  escalationProvider.name
                );
              }
              writeUpstreamResponse(res, escalationResult.status, escalationResult.headers, finalBody);
              return;
            }
            // Escalation failed — fall through to original response
          }
        }
      }
    }

    // --- Translate response back if cross-provider routed ---
    let finalBody = responseResult.body;
    if (needsResponseTranslation && responseResult.status >= 200 && responseResult.status < 300) {
      finalBody = translateResponseBack(responseResult.body, sourceFormat, effectiveProvider.name);
    }

    writeUpstreamResponse(res, responseResult.status, responseResult.headers, finalBody);
  }

  /**
   * Executes a request against a provider's key pool with bounded retry.
   * Returns the upstream response, or null if no keys are available.
   */
  private async executeProviderRequest(
    req: http.IncomingMessage,
    provider: Provider,
    upstreamPath: string,
    body: Buffer,
    started: number,
    routedTier?: TaskTier,
    escalated?: boolean
  ): Promise<ProviderResponse | null> {
    const destination = `${provider.upstream.host}${upstreamPath}`;

    const method = req.method || "GET";
    let pool: { name: string; value: string; pins: Pin[] | null }[];
    try {
      pool = await vault.getPool(placeholderPool(req.headers, provider.name));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[AgentPass] Vault unavailable for ${provider.name}: ${message}`);
      return null;
    }

    if (pool.length === 0) {
      appendAudit({
        method: req.method || "GET",
        destination,
        secretNames: [],
        statusCode: 503,
        durationMs: Date.now() - started,
        error: `no keys configured for provider ${provider.name}`,
        routedTier,
        escalated,
      });
      return null;
    }

    const poolNames = pool.map((key) => key.name);
    pool = pool.filter(
      (key) => egressVerdict(key.name, key.pins, provider.upstream.host, method, upstreamPath) !== "deny"
    );
    if (pool.length === 0) {
      appendAudit({
        method,
        destination,
        secretNames: poolNames,
        statusCode: 403,
        durationMs: Date.now() - started,
        error: "egress_blocked",
        routedTier,
        escalated,
      });
      return {
        status: 403,
        headers: { "content-type": "application/json" },
        body: Buffer.from(
          JSON.stringify({ error: "egress_blocked", secret: poolNames[0], host: provider.upstream.host })
        ),
      };
    }

    const client = provider.upstream.protocol === "https" ? https : http;
    const upstreamPort =
      provider.upstream.port || (provider.upstream.protocol === "https" ? 443 : 80);

    let lastStatus = 502;

    // Bounded iteration: max attempts = pool size (Section 4.1)
    let attempts = 0;
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
          routedTier,
          escalated,
        });
        lastStatus = 502;
        continue;
      }

      appendAudit({
        method: req.method || "GET",
        destination,
        secretNames: [name],
        statusCode: result.status,
        durationMs: Date.now() - started,
        routedTier,
        escalated,
      });

      lastStatus = result.status;

      if (provider.isRateLimit(result.status) || provider.isAuthError(result.status)) {
        if (attempts >= maxAttempts) {
          console.warn(
            `[AgentPass] All ${maxAttempts} keys exhausted for ${provider.name}. Returning last error (${result.status}).`
          );
          return result;
        }
        // nothing has been sent to the client yet, so drop this body and fail over
        result.body.resume();
        continue;
      }

      return result;
    }

    return { status: lastStatus || 503, headers: {}, body: Buffer.from(
      JSON.stringify({
        error: "all_keys_exhausted",
        provider: provider.name,
        lastStatus,
      })
    ) };
  }

  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: Duplex,
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

      if (!(await this.shouldIntercept(hostname))) {
        this.tunnel(clientSocket, hostname, port, started);
        return;
      }

      const hostPair = certificateAuthority.getHostCertificate(hostname);
      const caPair = certificateAuthority.ensureCa();
      const certChain = `${hostPair.cert}\n${caPair.cert}`;

      const httpsServer = https.createServer({ key: hostPair.key, cert: certChain }, async (req, res) => {
        const startedReq = Date.now();
        try {
          const egress = await this.enforceEgress(req, res, hostname, req.url || "/", `${hostname}:${port}`, startedReq);
          if (!egress) return;
          const { wildcard } = egress;

          const substitution = await substitutePlaceholders(req.headers, egress.resolve);
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
          // the upstream connection goes to the CONNECT host, so Host must not front another site
          substitution.headers.host = port === 443 ? hostname : `${hostname}:${port}`;

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
                wildcard,
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
              wildcard,
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

  private async shouldIntercept(hostname: string): Promise<boolean> {
    try {
      const hosts = await vault.pinnedHosts();
      return hosts.has("*") || hosts.has(hostname.toLowerCase());
    } catch {
      // locked vault: nothing can be substituted, so there is no reason to break TLS
      return false;
    }
  }

  // Unpinned hosts get a raw TCP tunnel, so the local CA never touches their TLS.
  private tunnel(clientSocket: Duplex, hostname: string, port: number, started: number): void {
    const destination = `${hostname}:${port}`;
    let connected = false;
    const upstream = net.connect(port, hostname, () => {
      connected = true;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      appendAudit({
        method: "CONNECT",
        destination,
        secretNames: [],
        statusCode: 200,
        durationMs: Date.now() - started,
      });
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on("error", (err) => {
      if (connected) {
        clientSocket.destroy();
        return;
      }
      appendAudit({
        method: "CONNECT",
        destination,
        secretNames: [],
        statusCode: 502,
        durationMs: Date.now() - started,
        error: err.message,
      });
      try { clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { }
    });
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => upstream.destroy());
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

function placeholderNames(headers: http.IncomingHttpHeaders): string[] {
  const names = new Set<string>();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (!SCANNED_HEADERS.has(headerName.toLowerCase()) || typeof headerValue !== "string") continue;
    for (const match of headerValue.matchAll(PLACEHOLDER_RE)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names];
}

// A placeholder naming one of this provider's keys (e.g. anthropic-clienta) selects that key's pool.
function placeholderPool(headers: http.IncomingHttpHeaders, provider: string): string {
  return placeholderNames(headers).find((name) => name === provider || name.startsWith(`${provider}-`)) ?? provider;
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
    // client credentials, real or placeholder, never reach the provider; applyAuth sets the pool key
    if (SCANNED_HEADERS.has(key.toLowerCase())) continue;
    if (value !== undefined) out[key] = value as string | string[];
  }
  out["host"] = upstreamHost;
  return out;
}

interface UpstreamSuccess {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
}

interface ProviderResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer | http.IncomingMessage;
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
      (res) => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res })
    );
    req.on("error", (err) => resolve({ error: err.message }));
    if (opts.body.length > 0) req.write(opts.body);
    req.end();
  });
}

function responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "content-length") continue;
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function writeUpstreamResponse(
  res: http.ServerResponse,
  status: number,
  headers: http.IncomingHttpHeaders,
  body: Buffer
): void {
  res.writeHead(status, { ...responseHeaders(headers), "content-length": body.length });
  res.end(body);
}

function sendProviderResponse(res: http.ServerResponse, result: ProviderResponse): void {
  if (Buffer.isBuffer(result.body)) {
    writeUpstreamResponse(res, result.status, result.headers, result.body);
    return;
  }
  const upstream = result.body;
  res.writeHead(result.status, responseHeaders(result.headers));
  upstream.on("error", () => res.destroy());
  res.on("close", () => upstream.destroy());
  upstream.pipe(res);
}

async function bufferProviderResponse(result: ProviderResponse): Promise<ProviderResponse & { body: Buffer }> {
  return { ...result, body: Buffer.isBuffer(result.body) ? result.body : await readBody(result.body) };
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

// ---------------------------------------------------------------------------
// Cross-provider translation helpers (Section 3.5)
// ---------------------------------------------------------------------------

function translateRequestBody(
  body: Record<string, unknown>,
  sourceFormat: "openai" | "anthropic" | "unknown",
  targetProvider: string,
  targetModel: string
): Record<string, unknown> | null {
  try {
    if (sourceFormat === "openai" && targetProvider === "anthropic") {
      return translateOpenAIToAnthropic(body as OpenAIRequest, targetModel);
    }
    if (sourceFormat === "anthropic" && (targetProvider === "openai" || targetProvider === "groq" || targetProvider === "openrouter")) {
      return translateAnthropicToOpenAI(body as AnthropicRequest, targetModel);
    }
    // Same format family — just swap model
    return { ...body, model: targetModel };
  } catch {
    return null;
  }
}

function translateResponseBack(
  responseBody: Buffer,
  sourceFormat: "openai" | "anthropic" | "unknown",
  respondingProvider: string
): Buffer {
  try {
    const parsed = JSON.parse(responseBody.toString("utf-8")) as Record<string, unknown>;

    // If the agent sent OpenAI format but we routed to Anthropic,
    // translate the Anthropic response back to OpenAI format.
    if (sourceFormat === "openai" && respondingProvider === "anthropic") {
      const translated = translateAnthropicResponseToOpenAI(parsed as unknown as AnthropicResponse);
      return Buffer.from(JSON.stringify(translated), "utf-8");
    }

    // If the agent sent Anthropic format but we routed to OpenAI/Groq,
    // translate the OpenAI response back to Anthropic format.
    if (sourceFormat === "anthropic" && respondingProvider !== "anthropic") {
      const translated = translateOpenAIResponseToAnthropic(parsed as unknown as OpenAIResponse);
      return Buffer.from(JSON.stringify(translated), "utf-8");
    }

    return responseBody;
  } catch {
    return responseBody;
  }
}

function getProviderChatPath(provider: string): string {
  switch (provider) {
    case "openai":
    case "groq":
      return "/v1/chat/completions";
    case "anthropic":
      return "/v1/messages";
    case "openrouter":
      return "/api/v1/chat/completions";
    default:
      return "/v1/chat/completions";
  }
}

