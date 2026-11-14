import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { IntegrityError, Vault, valueAad, vault as sharedVault, vaultUnlockMode } from "./vault";
import { appendAudit, listAudit } from "./audit";
import { certificateAuthority } from "./ca";
import { agentPassDir, caCertFile, saltFile, vaultFile } from "./paths";
import { ProxyServer, substitutePlaceholders } from "./proxy";
import { makePlaceholder } from "./placeholder";

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
    await writeLegacyVault(1, "correct-password", { openai: "sk-legacy", stripe: "sk_live_legacy" });

    await expect(new Vault().init("wrong-password")).rejects.toThrow("Invalid master password");
    expect(vaultSchema().columns).not.toContain("pins");

    const vault = new Vault();
    await vault.init("correct-password");
    expect(await vault.get("openai")).toBe("sk-legacy");
    expect(await vault.get("stripe")).toBe("sk_live_legacy");
    expect(await vault.getPins("stripe")).toBeNull();
    await vault.setPins("stripe", [{ host: "api.stripe.com" }]);
    vault.close();

    expect(vaultSchema()).toEqual({ columns: expect.arrayContaining(["pins"]), version: "3" });

    const reopened = new Vault();
    await reopened.init("correct-password");
    expect(await reopened.get("stripe")).toBe("sk_live_legacy");
    expect(await reopened.getPins("stripe")).toEqual([{ host: "api.stripe.com" }]);
    reopened.close();

    const db = new Database(vaultFile());
    db.run(`UPDATE meta SET value = '4' WHERE key = 'version'`);
    db.close();
    const newer = new Vault();
    await newer.init("correct-password");
    newer.close();
    expect(vaultSchema().version).toBe("4");
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
    expect(await vault.get("stripe")).toBe("sk_test_2");
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
    // the new key keeps each value bound to its pins
    tamper(`UPDATE secrets SET pins = '[{"host":"*"}]' WHERE name = 'stripe'`);
    await expect(reopened.get("stripe")).rejects.toThrow(IntegrityError);
    tamper(`UPDATE secrets SET pins = '[{"host":"api.stripe.com"}]' WHERE name = 'stripe'`);
    expect(await reopened.get("stripe")).toBe("sk_rekey_stripe");
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
    expect(await vault.getPool("openai-a_b")).toEqual({
      keys: [{ name: "openai-a_b", value: "sk-1", pins: [{ host: "api.openai.com", methods: ["POST"] }] }],
      failed: [],
    });
    vault.close();
  });

  test("binds each value to its name and pins, so editing them outside the vault fails closed", async () => {
    const vault = new Vault();
    await vault.init("correct-password");
    await vault.add("stripe", "sk_live_bound", "api_key", [{ host: "api.stripe.com", pathPrefix: "/v1" }]);
    await vault.add("anywhere", "sk-anywhere", "api_key", [{ host: "*:*" }]);
    await vault.add("openai", "sk-implicit");
    await vault.add("openai-2", "sk-implicit-2");

    // the reviewer's attack: widen pins with sqlite3, no key needed
    tamper(`UPDATE secrets SET pins = '[{"host":"*"}]' WHERE name = 'stripe'`);
    await expect(vault.get("stripe")).rejects.toThrow(IntegrityError);
    await expect(vault.getEntry("stripe")).rejects.toThrow('Secret "stripe" failed its integrity check');
    // the pins as written decrypt again; a reformatted but equal encoding is the same canonical AAD
    tamper(`UPDATE secrets SET pins = ' [ { "pathPrefix": "/v1", "host": "api.stripe.com" } ] ' WHERE name = 'stripe'`);
    expect(await vault.getEntry("stripe")).toEqual({ value: "sk_live_bound", pins: [{ host: "api.stripe.com", pathPrefix: "/v1" }] });

    // pins added to an implicitly pinned key, or JSON null in place of SQL NULL
    for (const pins of ['[{"host":"*:*"}]', "null", "[]", "not json"]) {
      tamper(`UPDATE secrets SET pins = ? WHERE name = 'openai'`, pins);
      expect(await vault.getPool("openai")).toEqual({ keys: [{ name: "openai-2", value: "sk-implicit-2", pins: null }], failed: ["openai"] });
    }
    tamper(`UPDATE secrets SET pins = NULL WHERE name = 'openai'`);
    expect(await vault.get("openai")).toBe("sk-implicit");

    // a ciphertext moved into a row with wider pins
    tamper(`UPDATE secrets SET value = (SELECT value FROM secrets WHERE name = 'stripe') WHERE name = 'anywhere'`);
    const moved = vault.get("anywhere");
    await expect(moved).rejects.toThrow(IntegrityError);
    await moved.catch((err: Error) => expect(err.message).not.toContain("sk_live_bound"));
    vault.close();
  });

  test("the AAD is canonical JSON of name and pins, with null for no pins", () => {
    const aad = (name: string, pins: string | null) => new TextDecoder().decode(valueAad(name, pins));
    // every stored value depends on these exact bytes
    expect(aad("stripe", '[{"methods":["POST"],"host":"api.stripe.com"}]')).toBe(
      '{"name":"stripe","pins":[{"host":"api.stripe.com","methods":["POST"]}]}'
    );
    expect(aad("openai", null)).toBe('{"name":"openai","pins":null}');
    expect(aad("svc", "[]")).toBe('{"name":"svc","pins":[]}');
    for (const bad of ["null", '{"host":"*"}', "not json"]) expect(() => aad("svc", bad)).toThrow();
  });

  test("a renamed row no longer decrypts", async () => {
    const vault = new Vault();
    await vault.init("correct-password");
    await vault.add("stripe", "sk_live_named", "api_key", [{ host: "api.stripe.com" }]);
    await vault.add("openai", "sk-pool");

    tamper(`UPDATE secrets SET name = 'stripe-2' WHERE name = 'stripe'`);
    await expect(vault.get("stripe-2")).rejects.toThrow(IntegrityError);
    expect(await vault.getPool("stripe")).toEqual({ keys: [], failed: ["stripe-2"] });

    tamper(`UPDATE secrets SET name = 'openai-x' WHERE name = 'openai'`);
    expect(await vault.getPool("openai")).toEqual({ keys: [], failed: ["openai-x"] });

    tamper(`UPDATE secrets SET name = 'stripe' WHERE name = 'stripe-2'`);
    expect(await vault.get("stripe")).toBe("sk_live_named");
    vault.close();
  });

  test("setPins and add re-encrypt under the new pins, and never re-bind pins edited outside the vault", async () => {
    const vault = new Vault();
    await vault.init("correct-password");
    await vault.add("stripe", "sk_live_1", "api_key", [{ host: "api.stripe.com" }]);
    const before = rawRows()[0]!.value;

    await vault.setPins("stripe", [{ host: "files.stripe.com" }]);
    expect(rawRows()[0]!.value).not.toBe(before);
    expect(await vault.get("stripe")).toBe("sk_live_1");
    await vault.add("stripe", "sk_live_2");
    expect(await vault.getEntry("stripe")).toEqual({ value: "sk_live_2", pins: [{ host: "files.stripe.com" }] });

    tamper(`UPDATE secrets SET pins = '[{"host":"*"}]' WHERE name = 'stripe'`);
    await expect(vault.setPins("stripe", [{ host: "*:*" }])).rejects.toThrow(IntegrityError);
    // rotation keeps the stored pins, so it must not launder tampered ones
    await expect(vault.add("stripe", "sk_live_3")).rejects.toThrow(IntegrityError);
    expect(await vault.getPins("stripe")).toEqual([{ host: "*" }]);

    // explicit pins replace the row without reading the old value
    await vault.add("stripe", "sk_live_4", "api_key", [{ host: "api.stripe.com" }]);
    expect(await vault.getEntry("stripe")).toEqual({ value: "sk_live_4", pins: [{ host: "api.stripe.com" }] });
    vault.close();
  });

  test("upgrades a v2 vault by binding every value to its pins, after a backup, and keeps the values", async () => {
    await writeLegacyVault(2, "correct-password", {
      openai: "sk-v2-openai",
      stripe: ["sk_live_v2", '[{"host":"api.stripe.com"}]'],
    });
    const v2 = rawRows();

    await expect(new Vault().init("wrong-password")).rejects.toThrow("Invalid master password");
    expect(vaultBackups()).toEqual([]);
    expect(vaultSchema().version).toBe("2");

    const vault = new Vault();
    await vault.init("correct-password");
    expect(await vault.get("openai")).toBe("sk-v2-openai");
    expect(await vault.getEntry("stripe")).toEqual({ value: "sk_live_v2", pins: [{ host: "api.stripe.com" }] });
    expect(vaultSchema().version).toBe("3");
    expect(rawRows().map((row) => row.value)).not.toContain(v2[0]!.value);

    const backups = vaultBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^vault\.db\.bak-v2-\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
    expect(rawRows(join(agentPassDir(), backups[0]!))).toEqual(v2);

    tamper(`UPDATE secrets SET pins = '[{"host":"*"}]' WHERE name = 'stripe'`);
    await expect(vault.get("stripe")).rejects.toThrow(IntegrityError);
    vault.close();

    const reopened = new Vault();
    await reopened.init("correct-password");
    expect(await reopened.get("openai")).toBe("sk-v2-openai");
    reopened.close();
    expect(vaultBackups()).toHaveLength(1);
  });

  test("a v2 upgrade that cannot read every value changes nothing and leaves no backup", async () => {
    await writeLegacyVault(2, "correct-password", { openai: "sk-v2-survives", stripe: null });
    const v2 = rawRows();

    const failed = new Vault().init("correct-password");
    await expect(failed).rejects.toThrow('"stripe"');
    await failed.catch((err: Error) => expect(err.message).not.toContain("sk-"));
    expect(rawRows()).toEqual(v2);
    expect(vaultSchema().version).toBe("2");
    expect(vaultBackups()).toEqual([]);
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

  test("stores a session tag and adds the column to an older audit database in place", () => {
    mkdirSync(agentPassDir(), { recursive: true });
    const db = new Database(join(agentPassDir(), "audit.db"));
    db.run(`CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, method TEXT NOT NULL,
      destination TEXT NOT NULL, secret_names TEXT NOT NULL, status_code INTEGER, duration_ms INTEGER NOT NULL,
      bytes_in INTEGER NOT NULL DEFAULT 0, bytes_out INTEGER NOT NULL DEFAULT 0, error TEXT, routed_tier TEXT,
      escalated INTEGER NOT NULL DEFAULT 0
    )`);
    db.run(`INSERT INTO audit_events (timestamp, method, destination, secret_names, duration_ms) VALUES (1, 'GET', 'old', '[]', 0)`);
    db.close();

    appendAudit({ method: "GET", destination: "new", secretNames: [], durationMs: 1, sessionTag: "agent-1" });

    const [latest, old] = listAudit(2);
    expect(latest).toMatchObject({ destination: "new", sessionTag: "agent-1" });
    expect(old).toMatchObject({ destination: "old" });
    expect(old?.sessionTag).toBeUndefined();
  });
});

describe("HTTPS proxy", () => {
  test("substitutes credential placeholders for direct proxy requests", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget();
    await sharedVault.add("openai", "sk-test", "api_key", [{ host: `127.0.0.1:${target.port}` }]);
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
    const target = await startTarget(certificateAuthority.getHostCertificate("localhost"));
    await sharedVault.add("openai", "sk-test", "api_key", [{ host: `localhost:${target.port}` }]);
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

    await sharedVault.setPins("openai", [{ host: `localhost:${target.port}` }]);
    const intercepted = await requestThroughConnectTunnel(proxy.getPort(), target.port, ca);
    expect(intercepted).toContain("200 OK");
    expect(target.requests[1]?.authorization).toBe("Bearer sk-test");

    await proxy.stop();
    await target.close();
  });

  test("parses bracketed IPv6 authorities on CONNECT and the forward path", async () => {
    await sharedVault.init("correct-password");
    const tlsTarget = await startTarget(certificateAuthority.getHostCertificate("::1"), "::1");
    const plainTarget = await startTarget(undefined, "::1");
    await sharedVault.add("v6", "sk-v6", "api_key", [
      { host: `[::1]:${tlsTarget.port}` },
      { host: `[0:0:0:0:0:0:0:1]:${plainTarget.port}` },
    ]);
    const proxy = await startProxy();

    const tunneled = await requestThroughConnectTunnel(proxy.getPort(), tlsTarget.port, readFileSync(caCertFile()), {
      authority: `[::1]:${tlsTarget.port}`,
      host: `[::1]:${tlsTarget.port}`,
      auth: "Bearer {{secret:v6}}",
      ip: "::1",
    });
    expect(tunneled).toContain("200 OK");
    expect(tlsTarget.requests[0]?.authorization).toBe("Bearer sk-v6");
    expect(tlsTarget.requests[0]?.host).toBe(`[::1]:${tlsTarget.port}`);

    const forwarded = await requestThroughDirectProxy(proxy.getPort(), plainTarget.port, {
      auth: "Bearer {{secret:v6}}",
      origin: `http://[::1]:${plainTarget.port}`,
    });
    expect(forwarded.status).toBe(200);
    expect(plainTarget.requests[0]?.authorization).toBe("Bearer sk-v6");

    await proxy.stop();
    await tlsTarget.close();
    await plainTarget.close();
  });

  test("intercepts every CONNECT host and port when a *:* pin exists", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: "*:*" }]);
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

  test("a pin without a port never releases the secret to another local port", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("loop", "sk-loop-never-leaks", "api_key", [{ host: "localhost" }]);
    const target = await startTarget();
    const proxy = await startProxy();

    const response = await requestThroughDirectProxy(proxy.getPort(), target.port, {
      auth: "Bearer {{secret:loop}}",
      origin: `http://localhost:${target.port}`,
      path: "/steal",
    });

    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toEqual({ error: "egress_blocked", secret: "loop", host: "localhost" });
    expect(target.requests).toHaveLength(0);

    await sharedVault.setPins("loop", [{ host: `localhost:${target.port}` }]);
    const pinned = await requestThroughDirectProxy(proxy.getPort(), target.port, {
      auth: "Bearer {{secret:loop}}",
      origin: `http://localhost:${target.port}`,
    });
    expect(pinned.status).toBe(200);
    expect(target.requests[0]?.authorization).toBe("Bearer sk-loop-never-leaks");

    await proxy.stop();
    await target.close();
  });

  test("a CONNECT to an unpinned port of a pinned host is tunneled, never substituted", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("loop", "sk-loop-never-leaks", "api_key", [{ host: "localhost" }]);
    const target = await startTarget(certificateAuthority.getHostCertificate("agentpass-target.test"));
    const proxy = await startProxy();

    const response = await requestThroughConnectTunnel(proxy.getPort(), target.port, readFileSync(caCertFile()), {
      auth: "Bearer {{secret:loop}}",
      servername: "agentpass-target.test",
    });

    expect(response).toContain("200 OK");
    expect(target.requests[0]?.authorization).toBe("Bearer {{secret:loop}}");

    await proxy.stop();
    await target.close();
  });

  test("enforces pinned methods and path prefixes", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget();
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: `127.0.0.1:${target.port}`, methods: ["POST"], pathPrefix: "/v1" }]);
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
    const target = await startTarget();
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: `127.0.0.1:${target.port}`, pathPrefix: "/v1" }]);
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
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: "*:*" }]);
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
    const target = await startTarget();
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: `127.0.0.1:${target.port}` }]);
    const proxy = await startProxy();

    const response = await requestThroughDirectProxy(proxy.getPort(), target.port, { auth: "Bearer {{secret:svc}}" });

    expect(response.status).toBe(200);
    expect(target.requests[0]?.authorization).toBe("Bearer sk-svc");

    await proxy.stop();
    await target.close();
  });

  test("tags forward requests from the proxy URL username and never forwards Proxy-Authorization", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget();
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: `127.0.0.1:${target.port}` }]);
    const proxy = await startProxy();
    const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString("base64")}`;
    const send = (proxyAuth: string) =>
      requestThroughDirectProxy(proxy.getPort(), target.port, {
        auth: "Bearer {{secret:svc}}",
        headers: { "proxy-authorization": proxyAuth },
      });

    expect((await send(basic("agent-1:"))).status).toBe(200);
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 200, sessionTag: "agent-1" });

    expect((await send(basic("claude%40work.2+x:"))).status).toBe(200);
    expect(listAudit(1)[0]?.sessionTag).toBe("claude@work.2+x");

    for (const ignored of [basic("bad tag:"), basic("a/b:"), basic(`${"a".repeat(97)}:`), basic("agent-1:hunter2"), basic("%E0%A4%A:"), "Bearer agent-1", basic(":")]) {
      expect((await send(ignored)).status).toBe(200);
      expect(listAudit(1)[0]?.sessionTag).toBeUndefined();
    }

    expect(target.requests.every((headers) => headers["proxy-authorization"] === undefined)).toBe(true);
    expect(JSON.stringify(listAudit(50))).not.toContain("hunter2");

    await proxy.stop();
    await target.close();
  });

  test("tags CONNECT tunnels and every request inside them", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget(certificateAuthority.getHostCertificate("localhost"));
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: `localhost:${target.port}` }]);
    const proxy = await startProxy();

    const response = await requestThroughConnectTunnel(proxy.getPort(), target.port, readFileSync(caCertFile()), {
      auth: "Bearer {{secret:svc}}",
      proxyAuth: `Basic ${Buffer.from("tunnel-7:").toString("base64")}`,
      innerHeaders: { "Proxy-Authorization": "Basic c211Z2dsZWQ6" },
    });

    expect(response).toContain("200 OK");
    expect(target.requests[0]?.authorization).toBe("Bearer sk-svc");
    expect(target.requests[0]?.["proxy-authorization"]).toBeUndefined();
    const [inner, connect] = listAudit(2);
    expect(inner).toMatchObject({ method: "GET", statusCode: 200, sessionTag: "tunnel-7" });
    expect(connect).toMatchObject({ method: "CONNECT", statusCode: 200, sessionTag: "tunnel-7" });

    await proxy.stop();
    await target.close();
  });

  test("format-preserving placeholders get the same pin, scheme, wildcard and missing checks", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget();
    await sharedVault.add("svc", "sk-real-svc", "api_key", [{ host: `127.0.0.1:${target.port}` }]);
    await sharedVault.add("stripe", "sk_live_never_leaks", "api_key", [{ host: "api.stripe.com" }, { host: "api.stripe.test" }]);
    await sharedVault.add("any", "sk-any", "api_key", [{ host: "*:*" }]);
    const proxy = await startProxy();
    const port = proxy.getPort();

    const ok = await requestThroughDirectProxy(port, target.port, {
      auth: `Bearer ${makePlaceholder("svc", "sk-proj-")}`,
      headers: { "x-api-key": makePlaceholder("svc", "sk-ant-api03-"), "api-key": makePlaceholder("svc") },
    });
    expect(ok.status).toBe(200);
    expect(target.requests[0]).toMatchObject({ authorization: "Bearer sk-real-svc", "x-api-key": "sk-real-svc", "api-key": "sk-real-svc" });

    const pinned = await requestThroughDirectProxy(port, target.port, { auth: `token ${makePlaceholder("stripe", "sk_live_")}` });
    expect(pinned.status).toBe(403);
    expect(JSON.parse(pinned.body)).toEqual({ error: "egress_blocked", secret: "stripe", host: "127.0.0.1" });

    const cleartext = await requestThroughDirectProxy(port, 0, {
      auth: `Basic ${makePlaceholder("stripe", "sk_live_")}`,
      origin: "http://api.stripe.test",
    });
    expect(cleartext.status).toBe(403);
    expect(JSON.parse(cleartext.body).error).toBe("insecure_scheme");

    const wildcard = await requestThroughDirectProxy(port, target.port, { auth: `Bearer ${makePlaceholder("any", "ghp_")}` });
    expect(wildcard.status).toBe(200);
    expect(listAudit(1)[0]).toMatchObject({ secretNames: ["any"], wildcard: ["any"] });

    const missing = await requestThroughDirectProxy(port, target.port, { auth: `Bearer ${makePlaceholder("nope", "sk-")}` });
    expect(missing.status).toBe(400);
    expect(missing.body).toBe("Missing secret: nope");
    const garbled = await requestThroughDirectProxy(port, target.port, { auth: "Bearer sk-AGENTPASSv1xffx" });
    expect(garbled.status).toBe(400);
    expect(target.requests).toHaveLength(2);
    expect(JSON.stringify(listAudit(50))).not.toContain("sk_live_never_leaks");

    await proxy.stop();
    await target.close();
  });

  test("format-preserving placeholders are substituted and pin-checked inside CONNECT tunnels", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget(certificateAuthority.getHostCertificate("localhost"));
    await sharedVault.add("gh", "ghp_real", "api_key", [{ host: `localhost:${target.port}`, methods: ["GET"] }]);
    const proxy = await startProxy();
    const ca = readFileSync(caCertFile());

    const ok = await requestThroughConnectTunnel(proxy.getPort(), target.port, ca, { auth: `token ${makePlaceholder("gh", "ghp_")}` });
    expect(ok).toContain("200 OK");
    expect(target.requests[0]?.authorization).toBe("token ghp_real");

    const blocked = await requestThroughConnectTunnel(proxy.getPort(), target.port, ca, {
      auth: `token ${makePlaceholder("gh", "ghp_")}`,
      method: "POST",
    });
    expect(blocked).toContain('"error":"egress_blocked"');
    expect(target.requests).toHaveLength(1);

    await proxy.stop();
    await target.close();
  });

  test("refuses forward and CONNECT requests aimed back at the proxy itself", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("svc", "sk-svc-no-loop", "api_key", [{ host: "*:*" }]);
    const proxy = await startProxy();
    const port = proxy.getPort();

    for (const host of ["127.0.0.1", "localhost", "127.1", "2130706433", "0x7f.0.0.1", "[::1]", "[::ffff:127.0.0.1]", "0.0.0.0", "localhost."]) {
      const response = await requestThroughDirectProxy(port, 0, {
        auth: "Bearer {{secret:svc}}",
        origin: `http://${host}:${port}`,
        path: "/openai/v1/models",
      });
      expect(response.status).toBe(508);
      expect(JSON.parse(response.body)).toEqual({ error: "loop_detected" });
      expect(listAudit(1)[0]).toMatchObject({ statusCode: 508, error: "loop_detected" });
    }

    for (const authority of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `0.0.0.0:${port}`]) {
      const response = await requestThroughConnectTunnel(port, port, Buffer.alloc(0), { authority });
      expect(response).toStartWith("HTTP/1.1 508");
      expect(listAudit(1)[0]).toMatchObject({ method: "CONNECT", statusCode: 508, error: "loop_detected" });
    }
    expect(JSON.stringify(listAudit(50))).not.toContain("sk-svc-no-loop");

    await proxy.stop();
  });

  test("refuses an absolute-form target inside a tunnel that names another authority", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget(certificateAuthority.getHostCertificate("localhost"));
    await sharedVault.add("svc", "sk-svc-never-fronted", "api_key", [{ host: `localhost:${target.port}` }]);
    const proxy = await startProxy();
    const ca = readFileSync(caCertFile());

    for (const path of ["https://evil.example:443/a", `https://localhost:${target.port + 1}/a`, "http://localhost/a"]) {
      const response = await requestThroughConnectTunnel(proxy.getPort(), target.port, ca, {
        auth: "Bearer {{secret:svc}}",
        path,
      });
      expect(response).toContain("403");
      expect(response).toContain('"error":"egress_blocked"');
      expect(listAudit(1)[0]).toMatchObject({ statusCode: 403, error: "egress_blocked" });
    }
    expect(target.requests).toHaveLength(0);

    const same = await requestThroughConnectTunnel(proxy.getPort(), target.port, ca, {
      auth: "Bearer {{secret:svc}}",
      path: `https://LOCALHOST:${target.port}/a?b=1`,
    });
    expect(same).toContain("200 OK");
    expect(target.urls).toEqual(["/a?b=1"]);
    expect(target.requests[0]?.authorization).toBe("Bearer sk-svc-never-fronted");
    expect(JSON.stringify(listAudit(50))).not.toContain("sk-svc-never-fronted");

    await proxy.stop();
    await target.close();
  });

  test("sends the origin-form target upstream on the forward path", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget();
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: `127.0.0.1:${target.port}` }]);
    const proxy = await startProxy();

    const response = await requestThroughDirectProxy(proxy.getPort(), target.port, {
      auth: "Bearer {{secret:svc}}",
      path: "/v1/x?y=1",
    });

    expect(response.status).toBe(200);
    expect(target.urls).toEqual(["/v1/x?y=1"]);

    await proxy.stop();
    await target.close();
  });

  test("denies a secret whose pins were edited outside the vault, with an integrity_failed audit row", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget();
    const tlsTarget = await startTarget(certificateAuthority.getHostCertificate("localhost"));
    await sharedVault.add("svc", "sk-svc-never-widened", "api_key", [{ host: "api.example.com" }]);
    const proxy = await startProxy();
    tamper(`UPDATE secrets SET pins = '[{"host":"*:*"}]' WHERE name = 'svc'`);

    const forward = await requestThroughDirectProxy(proxy.getPort(), target.port, { auth: "Bearer {{secret:svc}}" });
    expect(forward.status).toBe(403);
    expect(JSON.parse(forward.body)).toEqual({ error: "integrity_failed", secret: "svc", host: "127.0.0.1" });
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 403, error: "integrity_failed", secretNames: ["svc"] });

    // the widened plaintext pins still steer interception, but nothing is released inside the tunnel
    const tunneled = await requestThroughConnectTunnel(proxy.getPort(), tlsTarget.port, readFileSync(caCertFile()), {
      auth: "Bearer {{secret:svc}}",
    });
    expect(tunneled).toContain("403");
    expect(tunneled).toContain('"error":"integrity_failed"');
    expect(listAudit(1)[0]).toMatchObject({ statusCode: 403, error: "integrity_failed", secretNames: ["svc"] });

    expect(target.requests).toHaveLength(0);
    expect(tlsTarget.requests).toHaveLength(0);
    expect(JSON.stringify(listAudit(50))).not.toContain("sk-svc-never-widened");

    await proxy.stop();
    await target.close();
    await tlsTarget.close();
  });

  test("blocks placeholders inside CONNECT tunnels when pins do not match", async () => {
    await sharedVault.init("correct-password");
    const target = await startTarget(certificateAuthority.getHostCertificate("localhost"));
    await sharedVault.add("svc", "sk-svc", "api_key", [{ host: `localhost:${target.port}`, methods: ["POST"] }]);
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
  urls: string[];
  close: () => Promise<void>;
}

async function startTarget(tlsCert?: { cert: string; key: string }, host = "127.0.0.1"): Promise<Target> {
  const requests: http.IncomingHttpHeaders[] = [];
  const urls: string[] = [];
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    requests.push(req.headers);
    urls.push(req.url || "");
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  };
  const server = tlsCert ? https.createServer(tlsCert, handler) : http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Target server did not bind to a TCP port");
  return { port: address.port, requests, urls, close: () => new Promise((resolve) => server.close(() => resolve())) };
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
  authority?: string;
  ip?: string;
  headers?: Record<string, string>;
  proxyAuth?: string;
  innerHeaders?: Record<string, string>;
}

// Built by hand from the v1 and v2 schemas so the tests do not depend on the current Vault code.
// A v2 vault has a pins column and a password verifier; neither version binds values to anything.
// A secret given as [value, pins] gets that raw pins column; a value of null stores unreadable ciphertext.
async function writeLegacyVault(
  version: 1 | 2,
  password: string,
  secrets: Record<string, string | null | [string, string]>
): Promise<void> {
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

  const encrypt = async (plaintext: string) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
    return Buffer.concat([iv, new Uint8Array(ciphertext)]).toString("base64");
  };

  const db = new Database(vaultFile());
  db.run(`CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL,
    lastUsed INTEGER
    ${version === 2 ? ", pins TEXT" : ""}
  )`);
  db.run(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`INSERT INTO meta (key, value) VALUES ('version', ?)`, [String(version)]);
  if (version === 2) {
    db.run(`INSERT INTO meta (key, value) VALUES ('passwordVerifier', ?)`, [await encrypt(`agentpass-verifier:${crypto.randomUUID()}`)]);
  }
  for (const [name, secret] of Object.entries(secrets)) {
    const [value, pins] = Array.isArray(secret) ? secret : [secret, null];
    const stored = value === null ? Buffer.alloc(40, 7).toString("base64") : await encrypt(value);
    const now = Date.now();
    db.run(`INSERT INTO secrets (id, name, type, value, created, updated) VALUES (?, ?, 'api_key', ?, ?, ?)`, [
      crypto.randomUUID(), name, stored, now, now,
    ]);
    if (pins !== null) db.run(`UPDATE secrets SET pins = ? WHERE name = ?`, [pins, name]);
  }
  db.close();
}

function vaultBackups(): string[] {
  return readdirSync(agentPassDir()).filter((f) => /^vault\.db\.bak-[^-]*/.test(f) && !/-(wal|shm)$/.test(f));
}

function rawRows(file = vaultFile()): { name: string; value: string; pins: string | null }[] {
  const db = new Database(file);
  try {
    return db.query(`SELECT name, value, pins FROM secrets ORDER BY name`).all() as { name: string; value: string; pins: string | null }[];
  } finally {
    db.close();
  }
}

// What an agent running as the same user can do to the vault file without any key.
function tamper(sql: string, ...params: (string | null)[]): void {
  const db = new Database(vaultFile());
  try {
    db.run(sql, params);
  } finally {
    db.close();
  }
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
    headers = {},
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
          ...headers,
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
    authority = `localhost:${targetPort}`,
    ip,
    proxyAuth,
    innerHeaders = {},
  }: ProxiedRequest = {}
): Promise<string> {
  const socket = net.connect(proxyPort, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const connectAuth = proxyAuth ? `Proxy-Authorization: ${proxyAuth}\r\n` : "";
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${connectAuth}\r\n`);

  const established = await readUntil(socket, "\r\n\r\n");
  if (!established.startsWith("HTTP/1.1 200")) return established;

  const tlsSocket = tls.connect({
    socket,
    ...(ip ? { checkServerIdentity: (_: string, cert: tls.PeerCertificate) => tls.checkServerIdentity(ip, cert) } : { servername }),
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
      ...Object.entries(innerHeaders).map(([name, value]) => `${name}: ${value}`),
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
