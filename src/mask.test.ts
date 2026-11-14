import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { maskSecret } from "./mask";
import { scan } from "./scan";

// Built by concatenation so the repo itself never contains a scanner-shaped literal.
const BODY = "Q7mZ4kR9vT2wX8nB5cL3pH6jF1dS0gYa";

// The one rule behind every masked value: `agentpass get` and every `agentpass scan` preview.
const TABLE: [string, string][] = [
  ["", "…"],
  ["pw-Short-1234", "…"],
  ["sk-abcdefghijkl", "…"],
  ["Q7mZ4kR9vT2wX8n", "…"],
  ["abcdefghijklmnop", "…op"],
  ["a-random-password-of-forty-characters!Zq", "…Zq"],
  ["a8F3kL9qZ2xV7mN4pR6tY1wE", "…wE"],
  ["AKIA" + "Q7MZ4KR9VT2WX8NB", "…NB"],
  ["sk-abcdefghijklm", "sk…lm"],
  ["ghp" + "_Q7mZ4kR9vT2w", "gh…2w"],
  ["sk-abcdefghijklmnopq", "sk-…pq"],
  ["sk-planted-Q7xZ9mK2pL4vN8rT", "sk-…rT"],
  ["sk-ant-api03-abcdefghijklmnopqrstuvYZ", "sk-a…YZ"],
  ["sk-" + "proj-" + BODY, "sk-p…Ya"],
  ["sk-or-" + "v1-" + BODY, "sk-o…Ya"],
  ["ghp_abcdefghijklmnopqrstuvwxyz0123Zq", "ghp_…Zq"],
  ["gho" + "_" + BODY, "gho_…Ya"],
  ["sk_live_abcdefghijklmnopqrst9Q", "sk_l…9Q"],
  ["gsk" + "_" + BODY, "gsk_…Ya"],
  ["hf" + "_" + BODY, "hf_…Ya"],
  ["AIza" + "Sy" + BODY, "AIza…Ya"],
  ["npm" + "_" + BODY, "npm_…Ya"],
  ["glpat-" + BODY, "glpa…Ya"],
];

describe("maskSecret", () => {
  test.each(TABLE)("masks %p as %p", (value, masked) => {
    expect(maskSecret(value)).toBe(masked);
  });

  test("scan previews follow the same table", () => {
    const home = mkdtempSync(join(tmpdir(), "agentpass-mask-"));
    try {
      writeFileSync(join(home, ".zshrc"), TABLE.map(([value], i) => `export API_KEY_${i}=${value}\n`).join(""));
      const { findings } = scan({ home, roots: [] });
      expect(findings.length).toBeGreaterThanOrEqual(12);
      for (const finding of findings) expect(finding.preview).toBe(TABLE[Number(finding.name.slice("API_KEY_".length))]![1]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never shows more than min(6, a quarter) of the value", () => {
    for (let len = 16; len <= 80; len++) {
      for (const prefix of ["sk-ant-", "ghp_", "hf_", "AIza", "x"]) {
        const value = (prefix + "q".repeat(len)).slice(0, len);
        const shown = maskSecret(value).replace("…", "").length;
        expect(shown).toBeLessThanOrEqual(Math.min(6, Math.floor(len * 0.25)));
      }
    }
  });
});
