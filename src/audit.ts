import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { auditFile } from "./paths";

export interface AuditRecord {
  timestamp?: number;
  method: string;
  destination: string;
  secretNames: string[];
  statusCode?: number;
  durationMs: number;
  bytesIn?: number;
  bytesOut?: number;
  error?: string;
  routedTier?: string;
  escalated?: boolean;
}

export interface StoredAuditRecord extends AuditRecord {
  id: number;
  timestamp: number;
  secretNames: string[];
}

function openAuditDb(): Database {
  const file = auditFile();
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.run(`PRAGMA journal_mode = WAL`);
  db.run(`PRAGMA busy_timeout = 5000`);
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      method TEXT NOT NULL,
      destination TEXT NOT NULL,
      secret_names TEXT NOT NULL,
      status_code INTEGER,
      duration_ms INTEGER NOT NULL,
      bytes_in INTEGER NOT NULL DEFAULT 0,
      bytes_out INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      routed_tier TEXT,
      escalated INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

export function appendAudit(record: AuditRecord): void {
  const db = openAuditDb();
  try {
    db.run(
      `INSERT INTO audit_events (
        timestamp, method, destination, secret_names, status_code,
        duration_ms, bytes_in, bytes_out, error, routed_tier, escalated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.timestamp || Date.now(),
        record.method,
        record.destination,
        JSON.stringify(record.secretNames),
        record.statusCode ?? null,
        Math.max(0, Math.round(record.durationMs)),
        record.bytesIn || 0,
        record.bytesOut || 0,
        record.error ?? null,
        record.routedTier ?? null,
        record.escalated ? 1 : 0,
      ]
    );
  } finally {
    db.close();
  }
}

export function listAudit(limit = 20): StoredAuditRecord[] {
  const db = openAuditDb();
  try {
    const rows = db
      .query(
        `SELECT id, timestamp, method, destination, secret_names as secretNames,
                status_code as statusCode, duration_ms as durationMs,
                bytes_in as bytesIn, bytes_out as bytesOut, error,
                routed_tier as routedTier, escalated
         FROM audit_events
         ORDER BY timestamp DESC, id DESC
         LIMIT ?`
      )
      .all(limit) as Array<Omit<StoredAuditRecord, "secretNames" | "escalated"> & { secretNames: string; escalated: number }>;

    return rows.map((row) => ({
      ...row,
      secretNames: JSON.parse(row.secretNames) as string[],
      escalated: row.escalated === 1,
    }));
  } finally {
    db.close();
  }
}
