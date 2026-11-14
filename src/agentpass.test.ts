import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Vault, vault as sharedVault } from "./vault";
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
    await sharedVault.add("openai", "sk-test");
    let observedAuthorization = "";

    const target = http.createServer((req, res) => {
      observedAuthorization = String(req.headers.authorization || "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Target server did not bind to a TCP port");
    }

    const proxy = new ProxyServer({ port: 0, rejectUnauthorized: false });
    await proxy.start();

    const response = await requestThroughDirectProxy(proxy.getPort(), targetAddress.port);

    expect(response).toContain("200 OK");
    expect(response).toContain("ok");
    expect(observedAuthorization).toBe("Bearer sk-test");

    await proxy.stop();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  test("substitutes credential placeholders over HTTPS CONNECT tunnels", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("openai", "sk-test");

    const targetCert = certificateAuthority.getHostCertificate("localhost");
    let observedAuthorization = "";

    const target = https.createServer(
      {
        cert: targetCert.cert,
        key: targetCert.key,
      },
      (req, res) => {
        observedAuthorization = String(req.headers.authorization || "");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }
    );

    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Target server did not bind to a TCP port");
    }

    const proxy = new ProxyServer({ port: 0, rejectUnauthorized: false });
    await proxy.start();

    const response = await requestThroughConnectTunnel(
      proxy.getPort(),
      targetAddress.port,
      readFileSync(caCertFile())
    );

    expect(response).toContain("200 OK");
    expect(response).toContain("ok");
    expect(observedAuthorization).toBe("Bearer sk-test");

    await proxy.stop();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
});

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

async function requestThroughDirectProxy(proxyPort: number, targetPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}/models`,
        headers: {
          authorization: "Bearer {{secret:openai}}",
          connection: "close",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString("utf-8");
        });
        res.on("end", () => {
          resolve(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n${body}`);
        });
      }
    );
    req.once("error", reject);
    req.end();
  });
}

async function requestThroughConnectTunnel(
  proxyPort: number,
  targetPort: number,
  ca: Buffer
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
    servername: "localhost",
    ca,
    rejectUnauthorized: true,
  });

  await new Promise<void>((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });

  tlsSocket.write(
    [
      "GET /models HTTP/1.1",
      `Host: localhost:${targetPort}`,
      "Authorization: Bearer {{secret:openai}}",
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
