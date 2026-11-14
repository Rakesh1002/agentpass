import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { Vault, vault as sharedVault, vaultUnlockMode } from "./vault";
import { appendAudit, listAudit } from "./audit";
import { certificateAuthority } from "./ca";
import { agentPassDir, caCertFile, saltFile, vaultFile } from "./paths";
import { ProxyServer, substitutePlaceholders } from "./proxy";

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "agentpass-"));
  process.env.AGENTPASS_HOME = testHome;
});

afterEach(() => {
  sharedVault.close();
  delete process.env.AGENTPASS_HOME;
  rmSync(testHome, { recursive: true, force: true });
});

describe("vault", () => {
  test("encrypts secrets and rejects the wrong password", async () => {
    const vault = new Vault();
    await vault.init("correct-password");
    await vault.add("openai", "sk-test");
    expect(await vault.get("openai")).toBe("sk-test");
    vault.close();

    const reopened = new Vault();
    await expect(reopened.init("wrong-password")).rejects.toThrow("Invalid master password");
  });

  test("migrates a v1 vault file in place and keeps values decryptable", async () => {
    await writeV1Vault("correct-password", { openai: "sk-legacy", stripe: "sk_live_legacy" });

    await expect(new Vault().init("wrong-password")).rejects.toThrow("Invalid master password");
    expect(vaultSchema().columns).not.toContain("pins");

    const vault = new Vault();
    await vault.init("correct-password");
    expect(await vault.get("openai")).toBe("sk-legacy");
    expect(await vault.get("stripe")).toBe("sk_live_legacy");
    expect(await vault.getPins("stripe")).toBeNull();
    await vault.setPins("stripe", [{ host: "api.stripe.com" }]);
    vault.close();

    expect(vaultSchema()).toEqual({ columns: expect.arrayContaining(["pins"]), version: "2" });

    const reopened = new Vault();
    await reopened.init("correct-password");
    expect(await reopened.get("stripe")).toBe("sk_live_legacy");
    expect(await reopened.getPins("stripe")).toEqual([{ host: "api.stripe.com" }]);
    reopened.close();

    const db = new Database(vaultFile());
    db.run(`UPDATE meta SET value = '3' WHERE key = 'version'`);
    db.close();
    const newer = new Vault();
    await newer.init("correct-password");
    newer.close();
    expect(vaultSchema().version).toBe("3");
  });

  test("stores, preserves on rotation, replaces and clears pins", async () => {
    const vault = new Vault();
    await vault.init("correct-password");
    await vault.add("stripe", "sk_test_1", "api_key", [{ host: "API.stripe.com", methods: ["post"] }]);
    expect(await vault.getPins("stripe")).toEqual([{ host: "api.stripe.com", methods: ["POST"] }]);

    await vault.add("stripe", "sk_test_2");
    expect(await vault.get("stripe")).toBe("sk_test_2");
    expect(await vault.getPins("stripe")).toEqual([{ host: "api.stripe.com", methods: ["POST"] }]);

    expect(await vault.setPins("stripe", [{ host: "*" }])).toBe(true);
    expect((await vault.list()).map((s) => [s.name, s.pins])).toEqual([["stripe", [{ host: "*" }]]]);

    expect(await vault.setPins("stripe", null)).toBe(true);
    expect(await vault.getPins("stripe")).toBeNull();
    expect(await vault.setPins("missing", [{ host: "a.example" }])).toBe(false);

    const invalid = vault.add("other", "sk-never-echoed", "api_key", [{ host: "https://a.example" }]);
    await expect(invalid).rejects.toThrow("Invalid pin host");
    await invalid.catch((err: Error) => expect(err.message).not.toContain("sk-never-echoed"));
    expect(await vault.has("other")).toBe(false);
    vault.close();
  });

  test("tracks the pinned-host set and refreshes it when secrets change", async () => {
    const vault = new Vault();
    await vault.init("correct-password");
    await vault.add("openai", "sk-1");
    await vault.add("stripe", "sk_test");
    expect([...(await vault.pinnedHosts())]).toEqual(["api.openai.com"]);

    await vault.setPins("stripe", [{ host: "api.stripe.com" }]);
    expect([...(await vault.pinnedHosts())].sort()).toEqual(["api.openai.com", "api.stripe.com"]);

    await vault.delete("openai");
    expect([...(await vault.pinnedHosts())]).toEqual(["api.stripe.com"]);
    vault.close();
  });

  test("records the unlock mode, readable without the password", async () => {
    const vault = new Vault();
    await vault.init("correct-password");
    expect(vaultUnlockMode()).toBe("passphrase");
    vault.setUnlockMode("keychain");
    vault.close();
    expect(vaultUnlockMode()).toBe("keychain");
  });

  test("rekey backs up, re-encrypts every value under the new password and switches mode", async () => {
    const vault = new Vault();
    await vault.init("old-password");
    await vault.add("openai", "sk-rekey-openai");
    await vault.add("stripe", "sk_rekey_stripe", "api_key", [{ host: "api.stripe.com" }]);

    const backup = await vault.rekey("new-password-123", "keychain");
    expect(basename(backup)).toMatch(/^vault\.db\.bak-\d{4}-\d{2}-\d{2}T/);
    expect(dirname(backup)).toBe(agentPassDir());
    expect(vaultUnlockMode()).toBe("keychain");
    expect(await vault.get("openai")).toBe("sk-rekey-openai");
    vault.close();

    await expect(new Vault().init("old-password")).rejects.toThrow("Invalid master password");
    const reopened = new Vault();
    await reopened.init("new-password-123");
    expect(await reopened.get("openai")).toBe("sk-rekey-openai");
    expect(await reopened.get("stripe")).toBe("sk_rekey_stripe");
    expect(await reopened.getPins("stripe")).toEqual([{ host: "api.stripe.com" }]);
    reopened.close();

    const restored = mkdtempSync(join(tmpdir(), "agentpass-restore-"));
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(backup + suffix)) copyFileSync(backup + suffix, join(restored, "vault.db" + suffix));
      }
      copyFileSync(saltFile(), join(restored, "vault.salt"));
      process.env.AGENTPASS_HOME = restored;
      const old = new Vault();
      await old.init("old-password");
      expect(await old.get("stripe")).toBe("sk_rekey_stripe");
      old.close();
    } finally {
      process.env.AGENTPASS_HOME = testHome;
      rmSync(restored, { recursive: true, force: true });
    }
  });

  test("rekey changes nothing when any value fails to decrypt", async () => {
    const vault = new Vault();
    await vault.init("old-password");
    await vault.add("openai", "sk-survives");
    await vault.add("stripe", "sk_corrupt");
    const raw = new Database(vaultFile());
    raw.run(`UPDATE secrets SET value = ? WHERE name = 'stripe'`, [Buffer.alloc(40, 7).toString("base64")]);
    const before = raw.query(`SELECT name, value FROM secrets ORDER BY name`).all();
    const verifier = raw.query(`SELECT value FROM meta WHERE key = 'passwordVerifier'`).get();

    const failed = vault.rekey("new-password-123", "keychain");
    await expect(failed).rejects.toThrow("stripe");
    await failed.catch((err: Error) => expect(err.message).not.toContain("sk-"));
    expect(raw.query(`SELECT name, value FROM secrets ORDER BY name`).all()).toEqual(before);
    expect(raw.query(`SELECT value FROM meta WHERE key = 'passwordVerifier'`).get()).toEqual(verifier);
    raw.close();
    expect(vaultUnlockMode()).toBe("passphrase");
    expect(await vault.get("openai")).toBe("sk-survives");
    vault.close();

    const reopened = new Vault();
    await reopened.init("old-password");
    expect(await reopened.get("openai")).toBe("sk-survives");
    reopened.close();
  });

  test("getPool returns pins and treats pool names literally", async () => {
    const vault = new Vault();
    await vault.init("correct-password");
    await vault.add("openai-a_b", "sk-1", "api_key", [{ host: "api.openai.com", methods: ["POST"] }]);
    await vault.add("openai-aXb-1", "sk-2");
    expect(await vault.getPool("openai-a_b")).toEqual([
      { name: "openai-a_b", value: "sk-1", pins: [{ host: "api.openai.com", methods: ["POST"] }] },
    ]);
    vault.close();
  });
});

describe("placeholder substitution", () => {
  test("replaces configured credential headers and reports missing secrets", async () => {
    const result = await substitutePlaceholders(
      {
        authorization: "Bearer {{secret:openai}}",
        "x-api-key": "{{secret:missing}}",
        "content-type": "application/json",
      },
      async (name) => (name === "openai" ? "sk-test" : null)
    );

    expect(result.headers.authorization).toBe("Bearer sk-test");
    expect(result.headers["x-api-key"]).toBe("{{secret:missing}}");
    expect(result.secretNames).toEqual(["openai", "missing"]);
    expect(result.missingSecrets).toEqual(["missing"]);
  });
});

describe("audit log", () => {
  test("persists proxy audit events without secret values", () => {
    appendAudit({
      method: "GET",
      destination: "api.openai.com:443",
      secretNames: ["openai"],
      statusCode: 200,
      durationMs: 12,
    });

    const rows = listAudit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.destination).toBe("api.openai.com:443");
    expect(rows[0]?.secretNames).toEqual(["openai"]);
    expect(JSON.stringify(rows[0])).not.toContain("sk-test");
  });
});

describe("HTTPS proxy", () => {
  test("substitutes credential placeholders for direct proxy requests", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("openai", "sk-test", "api_key", [{ host: "127.0.0.1" }]);
    const target = await startTarget();
    const proxy = await startProxy();

    const response = await requestThroughDirectProxy(proxy.getPort(), target.port);

    expect(response).toEqual({ status: 200, body: "ok" });
    expect(target.requests[0]?.authorization).toBe("Bearer sk-test");
    // RFC 9112: a proxy replaces Host with the absolute-form authority
    expect(target.requests[0]?.host).toBe(`127.0.0.1:${target.port}`);

    await proxy.stop();
    await target.close();
  });

  test("substitutes credential placeholders over HTTPS CONNECT tunnels", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("openai", "sk-test", "api_key", [{ host: "localhost" }]);
    const target = await startTarget(certificateAuthority.getHostCertificate("localhost"));
    const proxy = await startProxy();

    const response = await requestThroughConnectTunnel(proxy.getPort(), target.port, readFileSync(caCertFile()), {
      host: "evil.example",
    });

    expect(response).toContain("200 OK");
    expect(response).toContain("ok");
    expect(target.requests[0]?.authorization).toBe("Bearer sk-test");
    // the request must reach the pinned host, never a fronted Host on the same IP
    expect(target.requests[0]?.host).toBe(`localhost:${target.port}`);

    await proxy.stop();
    await target.close();
  });

  test("tunnels unpinned CONNECT hosts without interception until a pin is added", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("openai", "sk-test");
    const target = await startTarget(certificateAuthority.getHostCertificate("agentpass-target.test"));
    const proxy = await startProxy();
    const ca = readFileSync(caCertFile());

    // a MITM would present a "localhost" leaf and fail verification against this servername
    const tunneled = await requestThroughConnectTunnel(proxy.getPort(), target.port, ca, {
      servername: "agentpass-target.test",
    });
    expect(tunneled).toContain("200 OK");
    expect(target.requests[0]?.authorization).toBe("Bearer {{secret:openai}}");

    await sharedVault.setPins("openai", [{ host: "localhost" }]);
    const intercepted = await requestThroughConnectTunnel(proxy.getPort(), target.port, ca);
    expect(intercepted).toContain("200 OK");
    expect(target.requests[1]?.authorization).toBe("Bearer sk-test");

    await proxy.stop();
    await target.close();
  });

  test("intercepts every CONNECT host when a wildcard pin exists", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: "*" }]);
    const target = await startTarget(certificateAuthority.getHostCertificate("localhost"));
    const proxy = await startProxy();

    const response = await requestThroughConnectTunnel(proxy.getPort(), target.port, readFileSync(caCertFile()), {
      auth: "Bearer {{secret:svc}}",
    });

    expect(response).toContain("200 OK");
    expect(target.requests[0]?.authorization).toBe("Bearer sk-svc");

    await proxy.stop();
    await target.close();
  });
});

describe("egress lock", () => {
  test("blocks a placeholder whose pins do not match the destination host", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("stripe", "sk_live_never_leaks", "api_key", [{ host: "api.stripe.com" }]);
    const target = await startTarget();
    const proxy = await startProxy();

    const response = await requestThroughDirectProxy(proxy.getPort(), target.port, {
      auth: "Bearer {{secret:stripe}}",
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "egress_blocked", secret: "stripe", host: "127.0.0.1" });
    expect(target.requests).toHaveLength(0);
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 403, error: "egress_blocked", secretNames: ["stripe"] });
    expect(JSON.stringify(listAudit(50))).not.toContain("sk_live_never_leaks");

    await proxy.stop();
    await target.close();
  });

  test("enforces pinned methods and path prefixes", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: "127.0.0.1", methods: ["POST"], pathPrefix: "/v1" }]);
    const target = await startTarget();
    const proxy = await startProxy();
    const auth = "Bearer {{secret:svc}}";

    expect((await requestThroughDirectProxy(proxy.getPort(), target.port, { auth, method: "GET", path: "/v1/x" })).status).toBe(403);
    expect((await requestThroughDirectProxy(proxy.getPort(), target.port, { auth, method: "POST", path: "/v2/x" })).status).toBe(403);
    expect(target.requests).toHaveLength(0);

    expect((await requestThroughDirectProxy(proxy.getPort(), target.port, { auth, method: "POST", path: "/v1/x" })).status).toBe(200);
    expect(target.requests[0]?.authorization).toBe("Bearer sk-svc");

    await proxy.stop();
    await target.close();
  });

  test("blocks encoded path separators under a path pin", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: "127.0.0.1", pathPrefix: "/v1" }]);
    const target = await startTarget();
    const proxy = await startProxy();

    const response = await requestThroughDirectProxy(proxy.getPort(), target.port, {
      auth: "Bearer {{secret:svc}}",
      path: "/v1/a%2F..%2Fadmin",
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "egress_blocked", secret: "svc", host: "127.0.0.1" });
    expect(target.requests).toHaveLength(0);
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 403, error: "egress_blocked", secretNames: ["svc"] });

    await proxy.stop();
    await target.close();
  });

  test("denies secrets without pins by default, including provider keys off their provider host", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("stripe", "sk_test");
    await sharedVault.add("openai", "sk-test");
    const target = await startTarget();
    const proxy = await startProxy();

    const unpinned = await requestThroughDirectProxy(proxy.getPort(), target.port, { auth: "Bearer {{secret:stripe}}" });
    const provider = await requestThroughDirectProxy(proxy.getPort(), target.port, { auth: "Bearer {{secret:openai}}" });

    expect(unpinned.status).toBe(403);
    expect(JSON.parse(unpinned.body).secret).toBe("stripe");
    expect(provider.status).toBe(403);
    expect(JSON.parse(provider.body).secret).toBe("openai");
    expect(target.requests).toHaveLength(0);

    await proxy.stop();
    await target.close();
  });

  test("allows any host with an explicit wildcard pin and records it in the audit", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: "*" }]);
    const target = await startTarget();
    const proxy = await startProxy();

    const response = await requestThroughDirectProxy(proxy.getPort(), target.port, { auth: "Bearer {{secret:svc}}" });

    expect(response.status).toBe(200);
    expect(target.requests[0]?.authorization).toBe("Bearer sk-svc");
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 200, secretNames: ["svc"], wildcard: ["svc"] });

    await proxy.stop();
    await target.close();
  });

  test("never substitutes into cleartext HTTP toward a non-loopback host", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("stripe", "sk_live_never_cleartext", "api_key", [{ host: "api.stripe.test" }]);
    const proxy = await startProxy();

    const response = await requestThroughDirectProxy(proxy.getPort(), 0, {
      auth: "Bearer {{secret:stripe}}",
      origin: "http://api.stripe.test",
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "insecure_scheme", secret: "stripe", host: "api.stripe.test" });
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 403, error: "insecure_scheme", secretNames: ["stripe"] });
    expect(JSON.stringify(listAudit(50))).not.toContain("sk_live_never_cleartext");

    await proxy.stop();
  });

  test("allows substitution over cleartext HTTP to a loopback host", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: "127.0.0.1" }]);
    const target = await startTarget();
    const proxy = await startProxy();

    const response = await requestThroughDirectProxy(proxy.getPort(), target.port, { auth: "Bearer {{secret:svc}}" });

    expect(response.status).toBe(200);
    expect(target.requests[0]?.authorization).toBe("Bearer sk-svc");

    await proxy.stop();
    await target.close();
  });

  test("blocks placeholders inside CONNECT tunnels when pins do not match", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: "localhost", methods: ["POST"] }]);
    const target = await startTarget(certificateAuthority.getHostCertificate("localhost"));
    const proxy = await startProxy();

    const response = await requestThroughConnectTunnel(proxy.getPort(), target.port, readFileSync(caCertFile()), {
      auth: "Bearer {{secret:svc}}",
    });

    expect(response).toContain("403");
    expect(response).toContain('"error":"egress_blocked"');
    expect(response).not.toContain("sk-svc");
    expect(target.requests).toHaveLength(0);
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 403, error: "egress_blocked", secretNames: ["svc"] });

    await proxy.stop();
    await target.close();
  });
});

interface Target {
  port: number;
  requests: http.IncomingHttpHeaders[];
  close: () => Promise<void>;
}

async function startTarget(tlsCert?: { cert: string; key: string }): Promise<Target> {
  const requests: http.IncomingHttpHeaders[] = [];
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    requests.push(req.headers);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  };
  const server = tlsCert ? https.createServer(tlsCert, handler) : http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server did not bind to a TCP port");
  return { port: address.port, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function startProxy(): Promise<ProxyServer> {
  const proxy = new ProxyServer({ port: 0, rejectUnauthorized: false });
  await proxy.start();
  return proxy;
}

interface ProxiedRequest {
  method?: string;
  path?: string;
  auth?: string;
  host?: string;
  servername?: string;
  origin?: string;
}

// Built by hand from the v1 schema so the test does not depend on the current Vault code.
async function writeV1Vault(password: string, secrets: Record<string, string>): Promise<void> {
  mkdirSync(agentPassDir(), { recursive: true });
  const salt = crypto.getRandomValues(new Uint8Array(16));
  writeFileSync(saltFile(), salt);
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );

  const db = new Database(vaultFile());
  db.run(`CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    lastUsed INTEGER
  )`);
  db.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`INSERT INTO meta (key, value) VALUES ('version', '1')`);
  for (const [name, value] of Object.entries(secrets)) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
    const now = Date.now();
    db.run(
      `INSERT INTO secrets (id, name, type, value, created, updated) VALUES (?, ?, 'api_key', ?, ?, ?)`,
      [crypto.randomUUID(), name, Buffer.concat([iv, new Uint8Array(ciphertext)]).toString("base64"), now, now]
    );
  }
  db.close();
}

function vaultSchema(): { columns: string[]; version: string | undefined } {
  const db = new Database(vaultFile());
  try {
    const columns = (db.query(`PRAGMA table_info(secrets)`).all() as { name: string }[]).map((c) => c.name);
    const row = db.query(`SELECT value FROM meta WHERE key = 'version'`).get() as { value: string } | undefined;
    return { columns, version: row?.value };
  } finally {
    db.close();
  }
}

async function requestThroughDirectProxy(
  proxyPort: number,
  targetPort: number,
  {
    method = "GET",
    path = "/models",
    auth = "Bearer {{secret:openai}}",
    origin = `http://127.0.0.1:${targetPort}`,
  }: ProxiedRequest = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method,
        path: `${origin}${path}`,
        headers: {
          authorization: auth,
          connection: "close",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      }
    );
    req.once("error", reject);
    req.end();
  });
}

async function requestThroughConnectTunnel(
  proxyPort: number,
  targetPort: number,
  ca: Buffer,
  {
    method = "GET",
    path = "/models",
    auth = "Bearer {{secret:openai}}",
    host = `localhost:${targetPort}`,
    servername = "localhost",
  }: ProxiedRequest = {}
): Promise<string> {
  const socket = net.connect(proxyPort, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  socket.write(
    `CONNECT localhost:${targetPort} HTTP/1.1\r\nHost: localhost:${targetPort}\r\n\r\n`
  );

  await readUntil(socket, "\r\n\r\n");

  const tlsSocket = tls.connect({
    socket,
    servername,
    ca,
    rejectUnauthorized: true,
  });

  await new Promise<void>((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });

  tlsSocket.write(
    [
      `${method} ${path} HTTP/1.1`,
      `Host: ${host}`,
      `Authorization: ${auth}`,
      "Connection: close",
      "",
      "",
    ].join("\r\n")
  );

  return readUntilEnd(tlsSocket);
}

function readUntil(socket: net.Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("utf-8");
      if (data.includes(marker)) {
        socket.off("data", onData);
        socket.off("error", reject);
        resolve(data);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function readUntilEnd(socket: tls.TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf-8");
    });
    socket.once("end", () => resolve(data));
    socket.once("error", reject);
  });
}
