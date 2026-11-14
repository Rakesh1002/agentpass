import http from "http";
import https from "https";
import net from "net";
import type { Duplex } from "stream";
import { certificateAuthority } from "./ca";
import { URL } from "url";
import { IntegrityError, vault } from "./vault";
import { appendAudit, type AuditRecord } from "./audit";
import { findPlaceholders, replacePlaceholders } from "./placeholder";
import { matchProvider, PROVIDERS, type Provider } from "./providers";
import {
  egressVerdict,
  isLocalHost,
  isLoopbackHost,
  parseAuthority,
  pinHostMatches,
  providerForSecret,
  unbracket,
  type Pin,
  type Scheme,
} from "./egress";
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
const SESSION_TAG_RE = /^[A-Za-z0-9._@+-]{1,96}$/;

// set where a request enters: the proxy URL username, or a /_t/<tag> reverse-route prefix
const sessionTags = new WeakMap<http.IncomingMessage, string>();

function audit(req: http.IncomingMessage, record: AuditRecord): void {
  appendAudit({ ...record, sessionTag: sessionTags.get(req) });
}

function tagRequest(req: http.IncomingMessage, raw: string | undefined): void {
  let tag = "";
  try {
    tag = decodeURIComponent(raw ?? "");
  } catch {}
  if (SESSION_TAG_RE.test(tag)) sessionTags.set(req, tag);
}

// http://<tag>@127.0.0.1:<port> as a proxy URL arrives as Proxy-Authorization: Basic base64("<tag>:")
function proxyAuthUser(header: string | string[] | undefined): string | undefined {
  const encoded = typeof header === "string" ? /^Basic\s+([A-Za-z0-9+/]+=*)$/i.exec(header.trim())?.[1] : undefined;
  return encoded ? /^([^:]+):$/.exec(Buffer.from(encoded, "base64").toString("latin1"))?.[1] : undefined;
}

export class ProxyServer {
  private server: http.Server | null = null;
  private config: ProxyConfig;
  // secret name -> epoch ms until which a rate-limited key is skipped
  private cooldowns = new Map<string, number>();

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
    let reqUrl = req.url || "";
    const isAbsolute = reqUrl.startsWith("http://") || reqUrl.startsWith("https://");

    if (!isAbsolute) {
      const tagged = /^\/_t\/([^/?]*)/.exec(reqUrl);
      if (tagged) {
        tagRequest(req, tagged[1]);
        reqUrl = reqUrl.slice(tagged[0].length);
      }

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

    tagRequest(req, proxyAuthUser(req.headers["proxy-authorization"]));
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
    const port = Number(url.port) || (isHttps ? 443 : 80);
    const destination = `${url.hostname}:${port}`;

    if (this.isSelf(url.hostname, port)) {
      audit(req, {
        method: req.method || "GET",
        destination,
        secretNames: placeholderNames(req.headers),
        statusCode: 508,
        durationMs: Date.now() - started,
        error: "loop_detected",
      });
      res.writeHead(508, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "loop_detected" }));
      return;
    }

    const names = placeholderNames(req.headers);
    // a secret in cleartext is readable by anyone on the path, whatever its pins say
    if (!isHttps && names.length > 0 && !isLoopbackHost(url.hostname)) {
      audit(req, {
        method: req.method || "GET",
        destination,
        secretNames: names,
        statusCode: 403,
        durationMs: Date.now() - started,
        error: "insecure_scheme",
      });
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "insecure_scheme", secret: names[0], host: url.hostname }));
      return;
    }

    const egress = await this.enforceEgress(req, res, url.hostname, port, isHttps ? "https" : "http", url.pathname, started);
    if (!egress) return;
    const { wildcard } = egress;

    const substitution = await substitutePlaceholders(req.headers, egress.resolve);
    if (substitution.missingSecrets.length > 0) {
      const error = `Missing secret: ${substitution.missingSecrets.join(", ")}`;
      audit(req, {
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
    delete substitution.headers["proxy-authorization"];

    const proxyReq = client.request(
      {
        hostname: unbracket(url.hostname),
        port,
        path: url.pathname + url.search,
        method: req.method,
        headers: substitution.headers,
        rejectUnauthorized: this.config.rejectUnauthorized,
      },
      (proxyRes) => {
        audit(req, {
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
      audit(req, {
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

  // Answers 403 and returns null if any placeholder's pins reject this destination, or its row fails its
  // integrity check (pins, name or value edited outside the vault).
  private async enforceEgress(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    host: string,
    port: number,
    scheme: Scheme,
    path: string,
    started: number
  ): Promise<{ resolve: (name: string) => Promise<string | null>; wildcard: string[] } | null> {
    const method = req.method || "GET";
    const destination = `${host}:${port}`;
    const names = placeholderNames(req.headers);
    const allowed = new Map<string, string>();
    const wildcard: string[] = [];
    const deny = (error: "egress_blocked" | "integrity_failed", name: string) => {
      audit(req, { method, destination, secretNames: names, statusCode: 403, durationMs: Date.now() - started, error });
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error, secret: name, host }));
      return null;
    };

    for (const name of names) {
      let entry: Awaited<ReturnType<typeof vault.getEntry>>;
      try {
        entry = await vault.getEntry(name);
      } catch (err) {
        if (err instanceof IntegrityError) return deny("integrity_failed", name);
        throw err;
      }
      if (!entry) continue;
      const verdict = egressVerdict(name, entry.pins, destination, method, path, scheme);
      if (verdict === "wildcard") wildcard.push(name);
      if (verdict === "deny") return deny("egress_blocked", name);
      allowed.set(name, entry.value);
    }

    // only values checked above may resolve, so a secret added or edited mid-request cannot skip the check
    const resolve = async (name: string) => allowed.get(name) ?? null;
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

    // the route picks the provider pool, so a placeholder naming another provider's key cannot be honored
    const foreign = placeholderNames(req.headers).find((name) => {
      const owner = providerForSecret(name);
      return owner !== undefined && owner.name !== provider.name;
    });
    if (foreign) {
      audit(req, {
        method: req.method || "GET",
        destination: `${provider.upstream.host}${upstreamPath}`,
        secretNames: [foreign],
        statusCode: 403,
        durationMs: Date.now() - started,
        error: "egress_blocked",
      });
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "egress_blocked", secret: foreign, host: provider.upstream.host }));
      return;
    }

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
    let failed: string[];
    try {
      ({ keys: pool, failed } = await vault.getPool(placeholderPool(req.headers, provider.name)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[AgentPass] Vault unavailable for ${provider.name}: ${message}`);
      return null;
    }

    // a key whose row was edited outside the vault is unavailable; the intact keys still serve
    if (failed.length > 0) {
      audit(req, {
        method,
        destination,
        secretNames: failed,
        statusCode: 403,
        durationMs: Date.now() - started,
        error: "integrity_failed",
        routedTier,
        escalated,
      });
      if (pool.length === 0) {
        return {
          status: 403,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: "integrity_failed", secret: failed[0], host: provider.upstream.host })),
        };
      }
    }

    if (pool.length === 0) {
      audit(req, {
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

    const upstreamPort =
      provider.upstream.port || (provider.upstream.protocol === "https" ? 443 : 80);
    const authority = `${provider.upstream.host}:${upstreamPort}`;
    const poolNames = pool.map((key) => key.name);
    const wildcardNames = new Set<string>();
    pool = pool.filter((key) => {
      const verdict = egressVerdict(key.name, key.pins, authority, method, upstreamPath, provider.upstream.protocol);
      if (verdict === "wildcard") wildcardNames.add(key.name);
      return verdict !== "deny";
    });
    const wildcardOf = (names: string[]) => names.filter((name) => wildcardNames.has(name));
    if (pool.length === 0) {
      audit(req, {
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

    let lastStatus = 502;

    // Bounded iteration: at most one attempt per key (Section 4.1)
    for (const { name, value } of pool) {
      if ((this.cooldowns.get(name) ?? 0) > Date.now()) continue;
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
        audit(req, {
          method: req.method || "GET",
          destination,
          secretNames: [name],
          statusCode: 502,
          durationMs: Date.now() - started,
          error: result.error,
          routedTier,
          escalated,
          wildcard: wildcardOf([name]),
        });
        lastStatus = 502;
        continue;
      }

      audit(req, {
        method: req.method || "GET",
        destination,
        secretNames: [name],
        statusCode: result.status,
        durationMs: Date.now() - started,
        routedTier,
        escalated,
        wildcard: wildcardOf([name]),
      });

      lastStatus = result.status;

      if (provider.isRateLimit(result.status)) {
        this.cooldowns.set(name, Date.now() + retryAfterMs(result.headers["retry-after"]));
      }
      if (provider.isRateLimit(result.status) || provider.isAuthError(result.status)) {
        // nothing has been sent to the client yet, so drop this body and fail over
        result.body.resume();
        continue;
      }

      return result;
    }

    const now = Date.now();
    const soonest = Math.min(
      ...pool.map((key) => this.cooldowns.get(key.name) ?? 0).filter((until) => until > now)
    );
    const cooling = Number.isFinite(soonest);
    const error = cooling ? "all_keys_cooling" : "all_keys_exhausted";
    const status = cooling ? 429 : 503;
    console.warn(`[AgentPass] All ${pool.length} keys unavailable for ${provider.name} (${error}).`);
    audit(req, {
      method,
      destination,
      secretNames: pool.map((key) => key.name),
      statusCode: status,
      durationMs: Date.now() - started,
      error,
      routedTier,
      escalated,
      wildcard: wildcardOf(pool.map((key) => key.name)),
    });

    if (cooling) {
      const retryAfter = Math.max(1, Math.ceil((soonest - now) / 1000));
      return {
        status,
        headers: { "content-type": "application/json", "retry-after": String(retryAfter) },
        body: Buffer.from(JSON.stringify({ error, provider: provider.name, retryAfter })),
      };
    }
    return {
      status,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ error, provider: provider.name, lastStatus })),
    };
  }

  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: Duplex,
    head: Buffer
  ): Promise<void> {
    const started = Date.now();
    const authority = parseAuthority(req.url || "");
    if (!authority) {
      clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      clientSocket.end();
      return;
    }
    const { host: hostname } = authority;
    const port = authority.port ?? 443;
    tagRequest(req, proxyAuthUser(req.headers["proxy-authorization"]));
    const tag = sessionTags.get(req);

    if (this.isSelf(hostname, port)) {
      audit(req, {
        method: "CONNECT",
        destination: `${hostname}:${port}`,
        secretNames: [],
        statusCode: 508,
        durationMs: Date.now() - started,
        error: "loop_detected",
      });
      clientSocket.end("HTTP/1.1 508 Loop Detected\r\n\r\n");
      return;
    }

    try {
      if (head.length > 0) clientSocket.unshift(head);

      if (!(await this.shouldIntercept(hostname, port))) {
        this.tunnel(req, clientSocket, hostname, port, started);
        return;
      }

      const hostPair = certificateAuthority.getHostCertificate(unbracket(hostname));
      const caPair = certificateAuthority.ensureCa();
      const certChain = `${hostPair.cert}\n${caPair.cert}`;

      const httpsServer = https.createServer({ key: hostPair.key, cert: certChain }, async (req, res) => {
        const startedReq = Date.now();
        if (tag) sessionTags.set(req, tag);
        try {
          const path = originFormTarget(req.url || "/", hostname, port);
          if (path === null) {
            audit(req, {
              method: req.method || "GET",
              destination: `${hostname}:${port}`,
              secretNames: placeholderNames(req.headers),
              statusCode: 403,
              durationMs: Date.now() - startedReq,
              error: "egress_blocked",
            });
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "egress_blocked", authority: `${hostname}:${port}` }));
            return;
          }

          const egress = await this.enforceEgress(req, res, hostname, port, "https", path, startedReq);
          if (!egress) return;
          const { wildcard } = egress;

          const substitution = await substitutePlaceholders(req.headers, egress.resolve);
          if (substitution.missingSecrets.length > 0) {
            audit(req, {
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
          delete substitution.headers["proxy-authorization"];

          const upstreamReq = https.request(
            {
              hostname: unbracket(hostname),
              port,
              path,
              method: req.method,
              headers: substitution.headers,
              rejectUnauthorized: this.config.rejectUnauthorized,
            },
            (upstreamRes) => {
              audit(req, {
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
            audit(req, {
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
          audit(req, {
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
        audit(req, {
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

          audit(req, {
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
      audit(req, {
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

  // a request the proxy would send to its own listener could loop without end
  private isSelf(host: string, port: number): boolean {
    return port === this.port() && (isLocalHost(host) || host === this.config.host);
  }

  private async shouldIntercept(hostname: string, port: number): Promise<boolean> {
    try {
      const hosts = await vault.pinnedHosts();
      return [...hosts].some((pinHost) => pinHostMatches(pinHost, hostname, port, 443));
    } catch {
      // locked vault: nothing can be substituted, so there is no reason to break TLS
      return false;
    }
  }

  // Unpinned hosts get a raw TCP tunnel, so the local CA never touches their TLS.
  private tunnel(req: http.IncomingMessage, clientSocket: Duplex, hostname: string, port: number, started: number): void {
    const destination = `${hostname}:${port}`;
    let connected = false;
    const upstream = net.connect(port, unbracket(hostname), () => {
      connected = true;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      audit(req, {
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
      audit(req, {
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

// RFC 9112 3.2.2: a server routes on an absolute-form authority, so inside a tunnel it must be the tunnel's own
function originFormTarget(target: string, host: string, port: number): string | null {
  if (target.startsWith("/") || target === "*") return target;
  try {
    const url = new URL(target);
    const urlPort = Number(url.port) || { "http:": 80, "https:": 443 }[url.protocol];
    return url.hostname === host && urlPort === port ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

const DEFAULT_COOLDOWN_MS = 60_000;
// a 429 always cools the key, or Retry-After: 0 would read as exhausted (503) instead of cooling (429)
const MIN_COOLDOWN_MS = 1_000;
// an upstream (or anything on its path) must not be able to bench a key for good
const MAX_COOLDOWN_MS = 3_600_000;

// Retry-After is either delta-seconds or an HTTP-date (RFC 9110 10.2.3).
function retryAfterMs(value: string | undefined): number {
  const raw = value?.trim();
  const clamp = (ms: number) => Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, ms));
  if (raw && /^\d+$/.test(raw)) return clamp(Number(raw) * 1000);
  const remaining = raw ? Date.parse(raw) - Date.now() : NaN;
  return remaining > 0 ? clamp(remaining) : DEFAULT_COOLDOWN_MS;
}

function placeholderNames(headers: http.IncomingHttpHeaders): string[] {
  const names = new Set<string>();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (!SCANNED_HEADERS.has(headerName.toLowerCase()) || typeof headerValue !== "string") continue;
    for (const { name } of findPlaceholders(headerValue)) names.add(name);
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
      (res) => {
        // consumers add their own handler; this keeps a reset on a discarded failover body from crashing
        res.on("error", () => {});
        resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res });
      }
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

