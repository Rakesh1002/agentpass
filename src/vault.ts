import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { agentPassDir, saltFile, vaultFile } from "./paths";

const VERIFIER_PREFIX = "agentpass-verifier:";

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

  async init(masterPassword: string): Promise<void> {
    const vaultDir = agentPassDir();
    mkdirSync(vaultDir, { recursive: true });

    this.encryptionKey = await this.deriveKey(masterPassword);

    const isNewVault = !existsSync(vaultFile());
    if (isNewVault) {
      this.db = new Database(vaultFile());
      this.db.run(`
        CREATE TABLE IF NOT EXISTS secrets (
          id TEXT PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          type TEXT NOT NULL,
          value TEXT NOT NULL,
          created INTEGER NOT NULL,
          updated INTEGER NOT NULL,
          lastUsed INTEGER
        )
      `);
      this.db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
      this.db.run(`INSERT INTO meta (key, value) VALUES ('version', '1')`);
    } else {
      this.db = new Database(vaultFile());
      this.db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    }

    await this.verifyPasswordOrUpgrade(isNewVault);
    this.isInitialized = true;
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

  private async encrypt(plaintext: string): Promise<string> {
    if (!this.encryptionKey) throw new Error("Vault not unlocked");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.encryptionKey,
      new TextEncoder().encode(plaintext)
    );
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return Buffer.from(combined).toString("base64");
  }

  private async decrypt(ciphertext: string): Promise<string> {
    if (!this.encryptionKey) throw new Error("Vault not unlocked");
    const combined = Buffer.from(ciphertext, "base64");
    const iv = combined.subarray(0, 12);
    const data = combined.subarray(12);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      this.encryptionKey,
      data
    );
    return new TextDecoder().decode(plaintext);
  }

  private async writeVerifier(): Promise<void> {
    if (!this.db) throw new Error("Vault not initialized");

    const verifier = await this.encrypt(`${VERIFIER_PREFIX}${crypto.randomUUID()}`);
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

  async add(name: string, value: string, type: string = "api_key"): Promise<void> {
    if (!this.db) throw new Error("Vault not initialized");

    const id = crypto.randomUUID();
    const now = Date.now();
    const encrypted = await this.encrypt(value);

    this.db.run(
      `INSERT OR REPLACE INTO secrets (id, name, type, value, created, updated) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, type, encrypted, now, now]
    );
  }

  async list(): Promise<{ name: string; type: string; updated: number }[]> {
    if (!this.db) throw new Error("Vault not initialized");

    const rows = this.db.query(
      `SELECT name, type, updated FROM secrets ORDER BY name`
    ).all() as { name: string; type: string; updated: number }[];

    return rows;
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
    return result.changes > 0;
  }

  async has(name: string): Promise<boolean> {
    if (!this.db) throw new Error("Vault not initialized");

    const row = this.db.query(`SELECT 1 FROM secrets WHERE name = ?`).get(name);
    return !!row;
  }

  async getPool(provider: string): Promise<{ name: string; value: string }[]> {
    if (!this.db) throw new Error("Vault not initialized");

    const rows = this.db.query(
      `SELECT name, value FROM secrets WHERE name = ? OR name LIKE ? ORDER BY name`
    ).all(provider, `${provider}-%`) as { name: string; value: string }[];

    const out: { name: string; value: string }[] = [];
    for (const row of rows) {
      out.push({ name: row.name, value: await this.decrypt(row.value) });
    }
    return out;
  }

  check(): boolean {
    return this.isInitialized && this.db !== null;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.isInitialized = false;
  }
}

export const vault = new Vault();
