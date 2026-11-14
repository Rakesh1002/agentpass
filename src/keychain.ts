import { spawnSync } from "child_process";
import { randomBytes } from "crypto";
import { vaultFile } from "./paths";

const SERVICE = "sh.agentpass";

export type Runner = (cmd: string, args: string[], input?: string) => { status: number | null; stdout: string; stderr: string };

// stdio stays piped so tool output never reaches the terminal
export const runCommand: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export interface Keychain {
  get(account: string): string | null;
  set(account: string, secret: string): void;
}

export function keychainAccount(): string {
  return vaultFile();
}

export function randomSecret(): string {
  return randomBytes(32).toString("base64");
}

export function keychain(run: Runner = runCommand, platform: string = process.platform): Keychain | null {
  if (platform === "darwin") return macKeychain(run);
  if (platform === "linux" && run("secret-tool", ["--version"]).status !== null) return linuxKeychain(run);
  return null;
}

export function macKeychain(run: Runner, file?: string): Keychain {
  const target = file ? [file] : [];
  const kc: Keychain = {
    get(account) {
      const r = run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w", ...target]);
      return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : null;
    },
    set(account, secret) {
      // `security -i` reads the command from stdin, keeping the secret out of argv
      const line = `add-generic-password -U -s ${SERVICE} -a ${quote(account)} -w ${quote(secret)}`;
      run("security", ["-i"], `${[line, ...target.map(quote)].join(" ")}\n`);
      verifyStored(kc, account, secret);
    },
  };
  return kc;
}

function linuxKeychain(run: Runner): Keychain {
  const attrs = (account: string) => ["service", SERVICE, "account", account];
  const kc: Keychain = {
    get(account) {
      const r = run("secret-tool", ["lookup", ...attrs(account)]);
      return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : null;
    },
    set(account, secret) {
      run("secret-tool", ["store", "--label", "AgentPass vault", ...attrs(account)], secret);
      verifyStored(kc, account, secret);
    },
  };
  return kc;
}

// Neither tool's exit status is reliable for writes (`security -i` exits 0 when the add fails).
function verifyStored(kc: Keychain, account: string, secret: string): void {
  if (kc.get(account) !== secret) throw new Error("Could not store the vault key in the keychain");
}

function quote(value: string): string {
  if (/["\\\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Keychain mode does not support quotes, backslashes or control characters in the vault path");
  }
  return `"${value}"`;
}
