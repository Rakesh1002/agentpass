import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { sandbox, type Sandbox } from "./testing";
import { Vault } from "./vault";

const PW = "test-password";
let box: Sandbox;

beforeEach(() => {
  box = sandbox();
});

afterEach(() => {
  rmSync(box.root, { recursive: true, force: true });
});

const keychainSecret = () => readFileSync(join(box.fakeDir, "keychain"), "utf-8").trim();
const argvLog = () => (existsSync(join(box.fakeDir, "argv.log")) ? readFileSync(join(box.fakeDir, "argv.log"), "utf-8") : "");
const backups = () => readdirSync(box.agentpassHome).filter((f) => /^vault\.db\.bak-[^-]+.*\d{3}Z$/.test(f));

describe("cli unlock", () => {
  test("init defaults to keychain mode and later commands unlock without a password", () => {
    const init = box.cli(["init"]);
    expect(init.code).toBe(0);
    expect(init.out).toContain("keychain mode");
    const secret = keychainSecret();
    expect(Buffer.from(secret, "base64")).toHaveLength(32);

    const added = box.cli(["add", "openai"], {}, "sk-keychain-value");
    expect(added.code).toBe(0);
    const got = box.cli(["get", "openai"]);
    expect(got.code).toBe(0);
    expect(got.out).toContain("openai: ");

    expect(argvLog()).not.toContain(secret);
    expect(init.out + init.err + added.out + added.err + got.out + got.err).not.toContain(secret);
  });

  test("init --passphrase and AGENTPASS_PASSWORD stay off the keychain", () => {
    expect(box.cli(["init", "--passphrase"]).err).toContain("AGENTPASS_PASSWORD");
    expect(existsSync(join(box.agentpassHome, "vault.db"))).toBe(false);

    const init = box.cli(["init"], { AGENTPASS_PASSWORD: PW });
    expect(init.code).toBe(0);
    expect(init.out).toContain("passphrase mode");
    expect(box.cli(["add", "openai"], { AGENTPASS_PASSWORD: PW }, "sk-passphrase-value").code).toBe(0);
    expect(box.cli(["list"], { AGENTPASS_PASSWORD: PW }).out).toContain("openai");
    expect(argvLog()).toBe("");

    const locked = box.cli(["list"]);
    expect(locked.code).toBe(1);
    expect(locked.err).toContain("AGENTPASS_PASSWORD");
    expect(box.cli(["list"], { AGENTPASS_PASSWORD: "wrong-password" }).err).toContain("Invalid master password");
  });

  test("the -p/--password flag no longer supplies the password", () => {
    expect(box.cli(["init"], { AGENTPASS_PASSWORD: PW }).code).toBe(0);
    for (const flag of [["-p", PW], [`--password=${PW}`]]) {
      const r = box.cli(["list", ...flag]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("AGENTPASS_PASSWORD");
    }
  });

  test("init leaves no vault behind when the keychain write fails", () => {
    const r = box.cli(["init"], { FAKE_KEYCHAIN_FAIL: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Could not store the vault key");
    expect(r.err).toContain("--passphrase");
    expect(existsSync(join(box.agentpassHome, "vault.db"))).toBe(false);
    expect(box.cli(["init"], { AGENTPASS_PASSWORD: PW }).code).toBe(0);
  });

  test("unlock-mode converts both ways, backing up first and keeping every value", async () => {
    expect(box.cli(["init"], { AGENTPASS_PASSWORD: PW }).code).toBe(0);
    box.cli(["add", "openai"], { AGENTPASS_PASSWORD: PW }, "sk-convert-openai");
    box.cli(["add", "stripe", "--host", "api.stripe.com"], { AGENTPASS_PASSWORD: PW }, "sk_convert_stripe");

    const toKeychain = box.cli(["unlock-mode", "keychain"], { AGENTPASS_PASSWORD: PW });
    expect(toKeychain.code).toBe(0);
    expect(toKeychain.out).toContain("keychain mode");
    expect(backups()).toHaveLength(1);
    expect(toKeychain.out).toContain(join(box.agentpassHome, backups()[0]!));
    expect(box.cli(["list"]).out).toContain("stripe (api_key) — pins: api.stripe.com");
    expect(box.cli(["status"]).out).toContain("Vault: keychain mode, unlockable");
    const secret = keychainSecret();

    expect(box.cli(["unlock-mode", "keychain"]).out).toContain("already uses keychain mode");
    expect(box.cli(["unlock-mode", "sideways"]).code).toBe(1);

    const toPassphrase = box.cli(["unlock-mode", "passphrase"], { AGENTPASS_PASSWORD: "new-passphrase" });
    expect(toPassphrase.code).toBe(0);
    expect(toPassphrase.out).toContain("passphrase mode");
    expect(backups()).toHaveLength(2);
    expect(box.cli(["list"]).code).toBe(1);
    expect(box.cli(["list"], { AGENTPASS_PASSWORD: "new-passphrase" }).out).toContain("openai");
    expect(box.cli(["list"], { AGENTPASS_PASSWORD: PW }).err).toContain("Invalid master password");

    const all = [toKeychain, toPassphrase].map((r) => r.out + r.err).join("");
    expect(all).not.toContain(secret);
    expect(all).not.toContain("sk-convert");
    expect(argvLog()).not.toContain(secret);

    process.env.AGENTPASS_HOME = box.agentpassHome;
    try {
      const v = new Vault();
      await v.init("new-passphrase");
      expect(await v.get("openai")).toBe("sk-convert-openai");
      expect(await v.get("stripe")).toBe("sk_convert_stripe");
      v.close();
    } finally {
      delete process.env.AGENTPASS_HOME;
    }
  });
});
