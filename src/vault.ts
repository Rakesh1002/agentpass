import { Database } from "bun:sqlite";
import { copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { agentPassDir, saltFile, vaultFile } from "./paths";
import { effectivePins, parseStoredPins, validatePins, type Pin } from "./egress";

const VERIFIER_PREFIX = "agentpass-verifier:";
// v3: each value is encrypted with its name and pins as AES-GCM additional data
const SCHEMA_VERSION = 3;
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

type StoredRow = { name: string; value: string; pins: string | null };

export class IntegrityError extends Error {
  constructor(readonly secret: string) {
    super(`Secret "${secret}" failed its integrity check: its name, pins or value were changed outside agentpass. Re-add it with --host, or delete it and add it again.`);
  }
}

// The plaintext pins column stays readable for the interception set, so the AAD is what makes it trustworthy:
// canonical JSON (sorted keys) of {name, pins}, with SQL NULL pins as an explicit null.
export function valueAad(name: string, pins: string | null): Uint8Array {
  const parsed: unknown = pins === null ? null : JSON.parse(pins);
  if (pins !== null && !Array.isArray(parsed)) throw new Error("Stored pins are not an array");
  const sorted = (_key: string, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v;
  return new TextEncoder().encode(JSON.stringify({ name, pins: parsed }, sorted));
}

export class Vault {
  private db: Database | null = null;
  private encryptionKey: CryptoKey | null = null;
  private isInitialized = false;
  private hostCache: { hosts: Set<string>; at: number } | null = null;

  // Returns the backup path when this unlock upgraded an older vault in place.
  async init(masterPassword: string): Promise<string | null> {
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
      this.db.run(`INSERT INTO meta (key, value) VALUES ('version', ?)`, [String(SCHEMA_VERSION)]);
    } else {
      this.db = new Database(vaultFile());
      this.db.run(`PRAGMA journal_mode = WAL`);
      this.db.run(`PRAGMA busy_timeout = 5000`);
      this.db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    }

    await this.verifyPasswordOrUpgrade(isNewVault);
    this.migrate();
    const upgradeBackup = await this.bindValues();
    this.isInitialized = true;
    return upgradeBackup;
  }

  private migrate(): void {
    if (!this.db) throw new Error("Vault not initialized");
    const columns = this.db.query(`PRAGMA table_info(secrets)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "pins")) {
      this.db.run(`ALTER TABLE secrets ADD COLUMN pins TEXT`);
    }
  }

  // v1/v2 values carry no AAD: re-encrypt each under its name and pins, after a backup, in one write
  // transaction that commits only if every value reads back. Returns the backup path, or null if nothing ran.
  private async bindValues(): Promise<string | null> {
    if (!this.db) throw new Error("Vault not initialized");
    const db = this.db;
    // a vault without a version row predates the meta table, so it is v1; never mark a newer vault as older
    const version = () =>
      Number((db.query(`SELECT value FROM meta WHERE key = 'version'`).get() as { value: string } | null)?.value ?? 1);
    if (version() >= SCHEMA_VERSION) return null;

    let backup: string | null = null;
    db.run("BEGIN IMMEDIATE");
    try {
      // another process may have upgraded the vault while this one waited for the write lock
      if (version() >= SCHEMA_VERSION) {
        db.run("COMMIT");
        return null;
      }
      backup = this.backup(`v${version()}-`);
      const rows = db.query(`SELECT id, name, value, pins FROM secrets`).all() as (StoredRow & { id: string })[];
      const plaintexts = new Map<string, string>();
      for (const row of rows) {
        try {
          const plaintext = await this.decrypt(row.value);
          plaintexts.set(row.id, plaintext);
          db.run(`UPDATE secrets SET value = ? WHERE id = ?`, [await this.seal(row, plaintext), row.id]);
        } catch {
          throw new Error(`Could not upgrade "${row.name}": its stored value or pins do not read; nothing was changed`);
        }
      }
      const written = db.query(`SELECT id, name, value, pins FROM secrets`).all() as (StoredRow & { id: string })[];
      for (const row of written) {
        const roundTrip = await this.open(row).catch(() => null);
        if (roundTrip !== plaintexts.get(row.id)) throw new Error(`"${row.name}" did not verify after the upgrade; nothing was changed`);
      }
      db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)`, [String(SCHEMA_VERSION)]);
      db.run("COMMIT");
      return backup;
    } catch (err) {
      db.run("ROLLBACK");
      this.close();
      // the rollback left the vault as it was, and a service restart loop would otherwise pile up copies
      for (const suffix of ["", "-wal", "-shm"]) if (backup) rmSync(backup + suffix, { force: true });
      throw err;
    }
  }

  // Copies vault.db with its -wal and -shm; callers hold the write lock so no commit lands mid-copy.
  private backup(label = ""): string {
    const backup = `${vaultFile()}.bak-${label}${new Date().toISOString().replace(/[:.]/g, "-")}`;
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(vaultFile() + suffix)) copyFileSync(vaultFile() + suffix, backup + suffix);
    }
    return backup;
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

  private async encrypt(plaintext: string, key = this.encryptionKey, additionalData?: Uint8Array): Promise<string> {
    if (!key) throw new Error("Vault not unlocked");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, ...(additionalData && { additionalData }) },
      key,
      new TextEncoder().encode(plaintext)
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return Buffer.from(combined).toString("base64");
  }

  private async decrypt(ciphertext: string, key = this.encryptionKey, additionalData?: Uint8Array): Promise<string> {
    if (!key) throw new Error("Vault not unlocked");
    const combined = Buffer.from(ciphertext, "base64");
    const iv = combined.subarray(0, 12);
    const data = combined.subarray(12);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, ...(additionalData && { additionalData }) },
      key,
      data
    );
    return new TextDecoder().decode(plaintext);
  }

  private async seal(row: { name: string; pins: string | null }, plaintext: string, key = this.encryptionKey): Promise<string> {
    return this.encrypt(plaintext, key, valueAad(row.name, row.pins));
  }

  // Throws IntegrityError when the row's name, pins or value differ from what was encrypted.
  private async open(row: StoredRow, key = this.encryptionKey): Promise<string> {
    if (!key) throw new Error("Vault not unlocked");
    try {
      return await this.decrypt(row.value, key, valueAad(row.name, row.pins));
    } catch {
      throw new IntegrityError(row.name);
    }
  }

  private row(name: string): StoredRow | null {
    if (!this.db) throw new Error("Vault not initialized");
    return this.db.query(`SELECT name, value, pins FROM secrets WHERE name = ?`).get(name) as StoredRow | null;
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
    // re-adding a secret (key rotation) keeps its pins unless new ones are given, and only pins that verify,
    // so a rotation never authenticates pins someone edited in the file
    const existing = pins === undefined ? this.row(name) : null;
    if (existing) await this.open(existing);
    const storedPins = pins === undefined ? (existing?.pins ?? null) : serializePins(pins);
    const encrypted = await this.seal({ name, pins: storedPins }, value);

    this.db.run(
      `INSERT OR REPLACE INTO secrets (id, name, type, value, created, updated, pins) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, type, encrypted, now, now, storedPins]
    );
    this.hostCache = null;
  }

  // Re-encrypts the value under the new pins; refuses a row that fails its integrity check.
  async setPins(name: string, pins: Pin[] | null): Promise<boolean> {
    if (!this.db) throw new Error("Vault not initialized");

    const stored = serializePins(pins);
    const row = this.row(name);
    if (!row) return false;
    const value = await this.seal({ name, pins: stored }, await this.open(row));
    const result = this.db.run(
      `UPDATE secrets SET pins = ?, value = ?, updated = ? WHERE name = ?`,
      [stored, value, Date.now(), name]
    );
    this.hostCache = null;
    return result.changes > 0;
  }

  // Plaintext pins for display; they are only trustworthy once the value decrypts under them (getEntry).
  async getPins(name: string): Promise<Pin[] | null> {
    return parseStoredPins(this.row(name)?.pins ?? null);
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
    const entry = await this.getEntry(name);
    if (entry) this.db?.run(`UPDATE secrets SET lastUsed = ? WHERE name = ?`, [Date.now(), name]);
    return entry?.value ?? null;
  }

  // Value and pins from one row read, so the pins a caller enforces are the ones the value decrypted under
  // and a concurrent edit of the file cannot split them. Throws IntegrityError on a tampered row.
  async getEntry(name: string): Promise<{ value: string; pins: Pin[] | null } | null> {
    const row = this.row(name);
    if (!row) return null;
    return { value: await this.open(row), pins: parseStoredPins(row.pins) };
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

  // Keys that fail their integrity check are left out and named in `failed`; the rest of the pool still serves.
  async getPool(provider: string): Promise<{ keys: { name: string; value: string; pins: Pin[] | null }[]; failed: string[] }> {
    if (!this.db) throw new Error("Vault not initialized");

    const rows = this.db.query(
      `SELECT name, value, pins FROM secrets WHERE name = ? OR name LIKE ? ESCAPE '\\' ORDER BY name`
    ).all(provider, `${provider.replace(/[\\%_]/g, "\\$&")}-%`) as StoredRow[];

    const keys: { name: string; value: string; pins: Pin[] | null }[] = [];
    const failed: string[] = [];
    for (const row of rows) {
      try {
        keys.push({ name: row.name, value: await this.open(row), pins: parseStoredPins(row.pins) });
      } catch (err) {
        if (!(err instanceof IntegrityError)) throw err;
        failed.push(row.name);
      }
    }
    return { keys, failed };
  }

  setUnlockMode(mode: UnlockMode): void {
    if (!this.db) throw new Error("Vault not initialized");
    this.db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('unlockMode', ?)`, [mode]);
  }

  // Re-encrypts every value under newPassword, bound to the same name and pins, in one write transaction;
  // returns the backup path.
  async rekey(newPassword: string, mode: UnlockMode): Promise<string> {
    if (!this.db || !this.encryptionKey) throw new Error("Vault not unlocked");
    const db = this.db;
    const newKey = await this.deriveKey(newPassword);

    // IMMEDIATE takes the write lock, so no other process can add a value under the old key mid-rekey
    db.run("BEGIN IMMEDIATE");
    let backup: string;
    try {
      backup = this.backup();
      const rows = db.query(`SELECT id, name, value, pins FROM secrets`).all() as (StoredRow & { id: string })[];
      const plaintexts = new Map<string, string>();
      for (const row of rows) {
        const plaintext = await this.open(row).catch(() => {
          throw new Error(`Could not decrypt "${row.name}"; nothing was changed`);
        });
        plaintexts.set(row.id, plaintext);
        db.run(`UPDATE secrets SET value = ? WHERE id = ?`, [await this.seal(row, plaintext, newKey), row.id]);
      }
      await this.writeVerifier(newKey);
      this.setUnlockMode(mode);

      const written = db.query(`SELECT id, name, value, pins FROM secrets`).all() as (StoredRow & { id: string })[];
      for (const row of written) {
        const roundTrip = await this.open(row, newKey).catch(() => null);
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
