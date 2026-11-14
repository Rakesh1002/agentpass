import { createHash } from "crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "fs";
import { resolve } from "path";
import { agentPassDir } from "./paths";

interface Entry {
  sha256: string;
  path: string;
}

export function allowedFile(): string {
  return resolve(agentPassDir(), "allowed.json");
}

// Checks the open fd, not the path, so the file checked is the file read. O_NONBLOCK keeps a FIFO from hanging.
// checkMode=false is for hash-trusted files, where an edit already revokes trust.
export function readOwnedFile(path: string, checkMode = true): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.uid !== process.getuid!()) throw new Error("not owned by you");
    if (checkMode && st.mode & 0o022) throw new Error(`group- or world-writable (fix: chmod go-w ${path})`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function load(): Entry[] {
  try {
    const data: unknown = JSON.parse(readOwnedFile(allowedFile()).toString("utf-8"));
    if (!Array.isArray(data)) return [];
    return data.filter((e) => typeof e?.sha256 === "string" && typeof e?.path === "string");
  } catch {
    return [];
  }
}

function save(entries: Entry[]): void {
  mkdirSync(agentPassDir(), { recursive: true, mode: 0o700 });
  const file = allowedFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

export function isAllowed(bytes: Uint8Array): boolean {
  const hash = sha256(bytes);
  return load().some((e) => e.sha256 === hash);
}

export function allow(path: string, bytes: Uint8Array): void {
  const hash = sha256(bytes);
  save([...load().filter((e) => e.sha256 !== hash || e.path !== path), { sha256: hash, path }]);
}

export function disallow(path: string, bytes: Uint8Array): void {
  const hash = sha256(bytes);
  save(load().filter((e) => e.sha256 !== hash && e.path !== path));
}
