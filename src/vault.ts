import { Database } from "bun:sqlite";
import { copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { agentPassDir, saltFile, vaultFile } from "./paths";
import { effectivePins, parseStoredPins, validatePins, type Pin } from "./egress";

const VERIFIER_PREFIX = "agentpass-verifier:";
const SCHEMA_VERSION = "2";
// other processes (agentpass add/pins) write the same file, so cached hosts expire quickly
const PINNED_HOSTS_TTL_MS = 5000;

export type UnlockMode = "keychain" | "passphrase";

export function vaultUnlockMode(): UnlockMode {
  const db = new Database(vaultFile());
  try {
    const row = db.query(`SELECT value FROM meta WHERE key = 'unlockMode'`).get() as { value: string } | undefined;
    return row?.value === "keychain" ? "keychain" : "passphrase";
  } catch {
    // v1 vaults have no meta table and predate keychain mode
    return "passphrase";
  } finally {
    db.close();
  }
}

interface Secret {
  id: string;
  name: string;
  type: string;
  value: string;
  created: number;
  updated: number;
  lastUsed?: number;
}

export class Vault {
  private db: Database | null = null;
  private encryptionKey: CryptoKey | null = null;
  private isInitialized = false;
  private hostCache: { hosts: Set<string>; at: number } | null = null;

  async init(masterPassword: string): Promise<void> {
    this.hostCache = null;
    const vaultDir = agentPassDir();
    mkdirSync(vaultDir, { recursive: true });

    this.encryptionKey = await this.deriveKey(masterPassword);

    const isNewVault = !existsSync(vaultFile());
    if (isNewVault) {
      this.db = new Database(vaultFile());
      this.db.run(`PRAGMA journal_mode = WAL`);
      this.db.run(`PRAGMA busy_timeout = 5000`);
      this.db.run(`
        CREATE TABLE IF NOT EXISTS secrets (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL,
          value TEXT NOT NULL,
          created INTEGER NOT NULL,
          updated INTEGER NOT NULL,
          lastUsed INTEGER,
          pins TEXT
        )
      `);
      this.db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
      this.db.run(`INSERT INTO meta (key, value) VALUES ('version', ?)`, [SCHEMA_VERSION]);
    } else {
      this.db = new Database(vaultFile());
      this.db.run(`PRAGMA journal_mode = WAL`);
      this.db.run(`PRAGMA busy_timeout = 5000`);
      this.db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    }

    await this.verifyPasswordOrUpgrade(isNewVault);
    this.migrate();
    this.isInitialized = true;
  }

  private migrate(): void {
    if (!this.db) throw new Error("Vault not initialized");
    const columns = this.db.query(`PRAGMA table_info(secrets)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "pins")) {
      this.db.run(`ALTER TABLE secrets ADD COLUMN pins TEXT`);
    }
    this.db.run(`INSERT OR IGNORE INTO meta (key, value) VALUES ('version', ?)`, [SCHEMA_VERSION]);
    // never mark a newer vault as older
    this.db.run(
      `UPDATE meta SET value = ? WHERE key = 'version' AND CAST(value AS INTEGER) < ?`,
      [SCHEMA_VERSION, Number(SCHEMA_VERSION)]
    );
  }

  private async deriveKey(password: string): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    const saltPath = saltFile();
    const salt = existsSync(saltPath)
      ? readFileSync(saltPath)
      : crypto.getRandomValues(new Uint8Array(16));

    if (!existsSync(saltPath)) {
      writeFileSync(saltPath, salt);
    }

    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      passwordBuffer,
      "PBKDF2",
      false,
      ["deriveBits", "deriveKey"]
    );

    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  private async encrypt(plaintext: string, key = this.encryptionKey): Promise<string> {
    if (!key) throw new Error("Vault not unlocked");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(plaintext)
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return Buffer.from(combined).toString("base64");
  }

  private async decrypt(ciphertext: string, key = this.encryptionKey): Promise<string> {
    if (!key) throw new Error("Vault not unlocked");
    const combined = Buffer.from(ciphertext, "base64");
    const iv = combined.subarray(0, 12);
    const data = combined.subarray(12);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );
    return new TextDecoder().decode(plaintext);
  }

  private async writeVerifier(key = this.encryptionKey): Promise<void> {
    if (!this.db) throw new Error("Vault not initialized");

    const verifier = await this.encrypt(`${VERIFIER_PREFIX}${crypto.randomUUID()}`, key);
    this.db.run(
      `INSERT OR REPLACE INTO meta (key, value) VALUES ('passwordVerifier', ?)`,
      [verifier]
    );
  }

  private async verifyPasswordOrUpgrade(isNewVault: boolean): Promise<void> {
    if (!this.db) throw new Error("Vault not initialized");

    const row = this.db
      .query(`SELECT value FROM meta WHERE key = 'passwordVerifier'`)
      .get() as { value: string } | undefined;

    if (row) {
      try {
        const verifier = await this.decrypt(row.value);
        if (!verifier.startsWith(VERIFIER_PREFIX)) {
          throw new Error("Invalid verifier");
        }
      } catch {
        this.close();
        throw new Error("Invalid master password");
      }
      return;
    }

    if (!isNewVault) {
      const secret = this.db
        .query(`SELECT value FROM secrets LIMIT 1`)
        .get() as { value: string } | undefined;

      if (secret) {
        try {
          await this.decrypt(secret.value);
        } catch {
          this.close();
          throw new Error("Invalid master password");
        }
      }
    }

    await this.writeVerifier();
  }

  async add(name: string, value: string, type: string = "api_key", pins?: Pin[] | null): Promise<void> {
    if (!this.db) throw new Error("Vault not initialized");

    const id = crypto.randomUUID();
    const now = Date.now();
    // re-adding a secret (key rotation) keeps its pins unless new ones are given
    const storedPins = pins === undefined ? this.storedPins(name) : serializePins(pins);
    const encrypted = await this.encrypt(value);

    this.db.run(
      `INSERT OR REPLACE INTO secrets (id, name, type, value, created, updated, pins) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, type, encrypted, now, now, storedPins]
    );
    this.hostCache = null;
  }

  async setPins(name: string, pins: Pin[] | null): Promise<boolean> {
    if (!this.db) throw new Error("Vault not initialized");

    const result = this.db.run(
      `UPDATE secrets SET pins = ?, updated = ? WHERE name = ?`,
      [serializePins(pins), Date.now(), name]
    );
    this.hostCache = null;
    return result.changes > 0;
  }

  async getPins(name: string): Promise<Pin[] | null> {
    return parseStoredPins(this.storedPins(name));
  }

  private storedPins(name: string): string | null {
    if (!this.db) throw new Error("Vault not initialized");
    const row = this.db.query(`SELECT pins FROM secrets WHERE name = ?`).get(name) as
      | { pins: string | null }
      | undefined;
    return row?.pins ?? null;
  }

  async pinnedHosts(): Promise<Set<string>> {
    if (!this.db) throw new Error("Vault not initialized");
    if (this.hostCache && Date.now() - this.hostCache.at < PINNED_HOSTS_TTL_MS) {
      return this.hostCache.hosts;
    }

    const rows = this.db.query(`SELECT name, pins FROM secrets`).all() as { name: string; pins: string | null }[];
    const hosts = new Set(
      rows.flatMap((row) => effectivePins(row.name, parseStoredPins(row.pins)).map((pin) => pin.host))
    );
    this.hostCache = { hosts, at: Date.now() };
    return hosts;
  }

  async list(): Promise<{ name: string; type: string; updated: number; pins: Pin[] | null }[]> {
    if (!this.db) throw new Error("Vault not initialized");

    const rows = this.db.query(
      `SELECT name, type, updated, pins FROM secrets ORDER BY name`
    ).all() as { name: string; type: string; updated: number; pins: string | null }[];

    return rows.map((row) => ({ ...row, pins: parseStoredPins(row.pins) }));
  }

  async get(name: string): Promise<string | null> {
    if (!this.db) throw new Error("Vault not initialized");

    const row = this.db.query(
      `SELECT value, lastUsed FROM secrets WHERE name = ?`
    ).get(name) as { value: string; lastUsed?: number } | undefined;

    if (!row) return null;

    this.db.run(
      `UPDATE secrets SET lastUsed = ? WHERE name = ?`,
      [Date.now(), name]
    );

    return this.decrypt(row.value);
  }

  async delete(name: string): Promise<boolean> {
    if (!this.db) throw new Error("Vault not initialized");

    const result = this.db.run(`DELETE FROM secrets WHERE name = ?`, [name]);
    this.hostCache = null;
    return result.changes > 0;
  }

  async has(name: string): Promise<boolean> {
    if (!this.db) throw new Error("Vault not initialized");

    const row = this.db.query(`SELECT 1 FROM secrets WHERE name = ?`).get(name);
    return !!row;
  }

  async getPool(provider: string): Promise<{ name: string; value: string; pins: Pin[] | null }[]> {
    if (!this.db) throw new Error("Vault not initialized");

    const rows = this.db.query(
      `SELECT name, value, pins FROM secrets WHERE name = ? OR name LIKE ? ESCAPE '\\' ORDER BY name`
    ).all(provider, `${provider.replace(/[\\%_]/g, "\\$&")}-%`) as { name: string; value: string; pins: string | null }[];

    const out: { name: string; value: string; pins: Pin[] | null }[] = [];
    for (const row of rows) {
      out.push({ name: row.name, value: await this.decrypt(row.value), pins: parseStoredPins(row.pins) });
    }
    return out;
  }

  setUnlockMode(mode: UnlockMode): void {
    if (!this.db) throw new Error("Vault not initialized");
    this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('unlockMode', ?)`, [mode]);
  }

  // Re-encrypts every value under newPassword in one write transaction; returns the backup path.
  async rekey(newPassword: string, mode: UnlockMode): Promise<string> {
    if (!this.db || !this.encryptionKey) throw new Error("Vault not unlocked");
    const db = this.db;
    const backup = `${vaultFile()}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const newKey = await this.deriveKey(newPassword);

    // IMMEDIATE takes the write lock, so no other process can add a value under the old key mid-rekey
    db.run("BEGIN IMMEDIATE");
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(vaultFile() + suffix)) copyFileSync(vaultFile() + suffix, backup + suffix);
      }
      const rows = db.query(`SELECT id, name, value FROM secrets`).all() as { id: string; name: string; value: string }[];
      const plaintexts = new Map<string, string>();
      for (const row of rows) {
        const plaintext = await this.decrypt(row.value).catch(() => {
          throw new Error(`Could not decrypt "${row.name}"; nothing was changed`);
        });
        plaintexts.set(row.id, plaintext);
        db.run(`UPDATE secrets SET value = ? WHERE id = ?`, [await this.encrypt(plaintext, newKey), row.id]);
      }
      await this.writeVerifier(newKey);
      this.setUnlockMode(mode);

      const written = db.query(`SELECT id, name, value FROM secrets`).all() as { id: string; name: string; value: string }[];
      for (const row of written) {
        const roundTrip = await this.decrypt(row.value, newKey).catch(() => null);
        if (roundTrip !== plaintexts.get(row.id)) throw new Error(`"${row.name}" did not verify under the new key; nothing was changed`);
      }
      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      throw err;
    }
    this.encryptionKey = newKey;
    this.hostCache = null;
    return backup;
  }

  check(): boolean {
    return this.isInitialized && this.db !== null;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.hostCache = null;
    this.isInitialized = false;
  }
}

function serializePins(pins: Pin[] | null): string | null {
  if (!pins || pins.length === 0) return null;
  return JSON.stringify(validatePins(pins));
}

export const vault = new Vault();
