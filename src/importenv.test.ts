import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { Vault } from "./vault";

const CLI = resolve(import.meta.dir, "cli.ts");
const OPENAI = "sk-proj-" + "a1B2c3D4e5".repeat(4);
const ANTHROPIC = "sk-ant-api03-" + "Zy9Xw8Vu7T".repeat(4);
const STRIPE = "sk_test_" + "Q1w2E3r4T5y6U7i8";
const AWS = "AKIA" + "ABCDEFGHIJ234567";

let home: string;
let proj: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "agentpass-import-")));
  proj = join(home, "proj");
  mkdirSync(proj);
  savedHome = process.env.AGENTPASS_HOME;
  expect(run("init").code).toBe(0);
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENTPASS_HOME;
  else process.env.AGENTPASS_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function run(...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: proj,
    encoding: "utf-8",
    env: { PATH: process.env.PATH, HOME: home, AGENTPASS_HOME: join(home, ".agentpass"), AGENTPASS_PASSWORD: "test-password" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

async function vaultValue(name: string): Promise<string | null> {
  process.env.AGENTPASS_HOME = join(home, ".agentpass");
  const v = new Vault();
  await v.init("test-password");
  try {
    return await v.get(name);
  } finally {
    v.close();
  }
}

const ENV = [
  "# keys",
  `OPENAI_API_KEY=${OPENAI}`,
  `export ANTHROPIC_API_KEY="${ANTHROPIC}"`,
  `STRIPE_SECRET_KEY='${STRIPE}' # test mode`,
  `AWS_ACCESS_KEY_ID=${AWS}`,
  "PORT=3000",
  "",
].join("\n");

test("moves known keys into the vault and leaves placeholders, links and every other line", async () => {
  writeFileSync(join(proj, ".env"), ENV);
  const r = run("import", "--yes");
  expect(r.code).toBe(0);
  expect(r.out).toContain("OPENAI_API_KEY -> openai-api-key (only sent to api.openai.com)");
  expect(r.out).toContain("AWS_ACCESS_KEY_ID: no known API host");

  const text = readFileSync(join(proj, ".env"), "utf-8");
  for (const moved of [OPENAI, ANTHROPIC, STRIPE]) expect(text).not.toContain(moved);
  expect(text).toContain(AWS);
  expect(text).toContain("# keys\n");
  expect(text).toContain("PORT=3000\n");
  expect(text).toMatch(/^OPENAI_API_KEY=sk-proj-AGENTPASSv1x[0-9a-f]+x$/m);
  expect(text).toMatch(/^export ANTHROPIC_API_KEY="sk-ant-api03-AGENTPASSv1x[0-9a-f]+x"$/m);
  expect(text).toMatch(/^STRIPE_SECRET_KEY='sk_test_AGENTPASSv1x[0-9a-f]+x' # test mode$/m);

  expect(await vaultValue("openai-api-key")).toBe(OPENAI);
  expect(await vaultValue("anthropic-api-key")).toBe(ANTHROPIC);
  expect(await vaultValue("stripe-secret-key")).toBe(STRIPE);
  expect(run("pins", "stripe-secret-key").out).toContain("api.stripe.com");

  const manifest = JSON.parse(readFileSync(join(proj, ".agentpass.json"), "utf-8"));
  expect(manifest.env).toEqual({
    ANTHROPIC_API_KEY: "anthropic-api-key",
    OPENAI_API_KEY: "openai-api-key",
    STRIPE_SECRET_KEY: "stripe-secret-key",
  });
  // import made the manifest itself, so it is trusted without a separate allow
  expect(run("project").code).toBe(0);

  const again = run("import", "--yes");
  expect(again.out).toContain("Nothing to move.");
  expect(readFileSync(join(proj, ".env"), "utf-8")).toBe(text);

  const scanned = JSON.parse(run("scan", "--json", "--root", proj).out);
  expect(JSON.stringify(scanned)).not.toContain("AGENTPASSv1x");
});

test("without a terminal or --yes nothing changes", async () => {
  writeFileSync(join(proj, ".env"), ENV);
  const r = run("import");
  expect(r.code).toBe(1);
  expect(r.err).toContain("--yes");
  expect(readFileSync(join(proj, ".env"), "utf-8")).toBe(ENV);
  expect(await vaultValue("openai-api-key")).toBeNull();
});

test("a different value already in the vault is skipped, not overwritten", async () => {
  const p = spawnSync(process.execPath, [CLI, "add", "openai-api-key"], {
    cwd: proj,
    input: "sk-other",
    env: { PATH: process.env.PATH, HOME: home, AGENTPASS_HOME: join(home, ".agentpass"), AGENTPASS_PASSWORD: "test-password" },
  });
  expect(p.status).toBe(0);
  writeFileSync(join(proj, ".env"), `OPENAI_API_KEY=${OPENAI}\n`);
  const r = run("import", "--yes");
  expect(r.out).toContain("the vault already has a different openai-api-key");
  expect(readFileSync(join(proj, ".env"), "utf-8")).toBe(`OPENAI_API_KEY=${OPENAI}\n`);
  expect(await vaultValue("openai-api-key")).toBe("sk-other");
});

test("a symlinked .env keeps its link and mode", () => {
  const real = join(home, "shared.env");
  writeFileSync(real, `OPENAI_API_KEY=${OPENAI}\n`);
  chmodSync(real, 0o600);
  symlinkSync(real, join(proj, ".env.local"));
  expect(run("import", "--yes").code).toBe(0);
  expect(lstatSync(join(proj, ".env.local")).isSymbolicLink()).toBe(true);
  expect(statSync(real).mode & 0o777).toBe(0o600);
  expect(readFileSync(real, "utf-8")).not.toContain(OPENAI);
});

test("the same variable with two values across files moves only the first", () => {
  writeFileSync(join(proj, ".env"), `OPENAI_API_KEY=${OPENAI}\n`);
  writeFileSync(join(proj, ".env.production"), `OPENAI_API_KEY=${OPENAI.replace("a1", "z9")}\n`);
  const r = run("import", "--yes");
  expect(r.out).toContain("openai-api-key already has a different value");
  expect(readFileSync(join(proj, ".env"), "utf-8")).not.toContain(OPENAI);
  expect(readFileSync(join(proj, ".env.production"), "utf-8")).toContain(OPENAI.replace("a1", "z9"));
});

test("CRLF files are imported and keep their line endings", async () => {
  writeFileSync(join(proj, ".env"), `OPENAI_API_KEY=${OPENAI}\r\nPORT=3000\r\n`);
  expect(run("import", "--yes").code).toBe(0);
  const text = readFileSync(join(proj, ".env"), "utf-8");
  expect(text).toMatch(/^OPENAI_API_KEY=sk-proj-AGENTPASSv1x[0-9a-f]+x\r\nPORT=3000\r\n$/);
  expect(await vaultValue("openai-api-key")).toBe(OPENAI);
});

test("a plain sk- key in a variable named after another provider is pinned to that provider", () => {
  const key = "sk-" + "0123456789abcdef".repeat(2);
  writeFileSync(join(proj, ".env"), `DEEPSEEK_API_KEY=${key}\nOPENAI_KEY=${key.replace("01", "99")}\n`);
  const r = run("import", "--yes");
  expect(r.out).toContain("DEEPSEEK_API_KEY -> deepseek-api-key (only sent to api.deepseek.com)");
  expect(r.out).toContain("OPENAI_KEY -> openai-key (only sent to api.openai.com)");
});

test("webhook and OAuth secrets named after a provider are skipped, not pinned to its API host", () => {
  const env = [
    "STRIPE_WEBHOOK_SECRET=whsec_Q8f3kLm9Zt2Xw7Vb4Nc1Rp6Ys0Hd5Jg",
    "GOOGLE_CLIENT_SECRET=GOCSPX-4kQ9zT2mXw7Vb1Nc8Rp6Ys0Hd5J",
    "GITHUB_CLIENT_SECRET=3f9a1c7e2b8d4f6a0c5e9b1d7f3a8c2e6b4d0f91",
    "",
  ].join("\n");
  writeFileSync(join(proj, ".env"), env);
  const r = run("import", "--yes");
  expect(r.out).not.toContain(" move ");
  expect(r.out.match(/ skip /g)).toHaveLength(3);
  expect(readFileSync(join(proj, ".env"), "utf-8")).toBe(env);
});

test("every copy of a key on its line is replaced, and an older key in a comment stays visible", () => {
  const old = OPENAI.replace("a1", "q7");
  writeFileSync(join(proj, ".env"), `OPENAI_API_KEY=${OPENAI} # same as ${OPENAI}, was ${old}\n`);
  expect(run("import", "--yes").code).toBe(0);
  const text = readFileSync(join(proj, ".env"), "utf-8");
  expect(text).not.toContain(OPENAI);
  expect(text).toContain(old);
  expect(JSON.parse(run("scan", "--json", "--root", proj).out).findings).toHaveLength(1);
  expect(run("import", "--yes").out).toContain("the vault already has a different openai-api-key");
});

test("naming the same file twice imports it once", () => {
  writeFileSync(join(proj, ".env"), `OPENAI_API_KEY=${OPENAI}\n`);
  const r = run("import", "--yes", ".env", ".env");
  expect(r.code).toBe(0);
  expect(r.out.match(/ move /g)).toHaveLength(1);
});

test.skipIf(process.getuid?.() === 0)("a file that can't be written stops the run before any file changes", () => {
  writeFileSync(join(proj, ".env"), `OPENAI_API_KEY=${OPENAI}\n`);
  mkdirSync(join(proj, "ro"));
  writeFileSync(join(proj, "ro", ".env"), `ANTHROPIC_API_KEY=${ANTHROPIC}\n`);
  chmodSync(join(proj, "ro"), 0o555);
  try {
    expect(run("import", "--yes", ".env", "ro/.env").code).toBe(1);
    expect(readFileSync(join(proj, ".env"), "utf-8")).toContain(OPENAI);
  } finally {
    chmodSync(join(proj, "ro"), 0o755);
  }
});
