import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const VAULT_FILE = resolve(process.env.HOME || "~", ".agentpass", "vault.db");
const SALT_FILE = resolve(process.env.HOME || "~", ".agentpass", "vault.salt");

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
    const vaultDir = resolve(process.env.HOME || "~", ".agentpass");
    const dirExists = existsSync(vaultDir);

    if (!dirExists) {
      const { mkdirSync } = await import("fs");
      mkdirSync(vaultDir, { recursive: true });
    }

    this.encryptionKey = await this.deriveKey(masterPassword);

    if (!existsSync(VAULT_FILE)) {
      this.db = new Database(VAULT_FILE);
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
      this.db = new Database(VAULT_FILE);
    }

    this.isInitialized = true;
  }

  private async deriveKey(password: string): Promise<CryptoKey> {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    const salt = existsSync(SALT_FILE)
      ? readFileSync(SALT_FILE)
      : crypto.getRandomValues(new Uint8Array(16));

    if (!existsSync(SALT_FILE)) {
      writeFileSync(SALT_FILE, salt);
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

  private encrypt(plaintext: string): string {
    if (!this.encryptionKey) throw new Error("Vault not unlocked");
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12));

    return crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      this.encryptionKey,
      encoder.encode(plaintext)
    ).then((ciphertext) => {
      const combined = new Uint8Array(iv.length + ciphertext.byteLength);
      combined.set(iv);
      combined.set(new Uint8Array(ciphertext), iv.length);
      return Buffer.from(combined).toString("base64");
    });
  }

  private decrypt(ciphertext: string): string {
    if (!this.encryptionKey) throw new Error("Vault not unlocked");
    const encoder = new TextEncoder();
    const combined = Buffer.from(ciphertext, "base64");
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);

    return crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      this.encryptionKey,
      data
    ).then((plaintext) => encoder.decode(plaintext));
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