import { describe, expect, test } from "bun:test";
import { maskSecret } from "./mask";

describe("maskSecret", () => {
  test("shows nothing of a value under 16 characters", () => {
    expect(maskSecret("")).toBe("…");
    expect(maskSecret("pw-Short-1234")).toBe("…");
    expect(maskSecret("sk-abcdefghijkl")).toBe("…");
  });

  test("shows only the last 2 characters without a known public prefix", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("…op");
    expect(maskSecret("a-random-password-of-forty-characters!Zq")).toBe("…Zq");
  });

  test("shows a known prefix, capped by the quarter-length budget and 4 leading characters", () => {
    expect(maskSecret("sk-abcdefghijklm")).toBe("sk…lm");
    expect(maskSecret("sk-abcdefghijklmnopq")).toBe("sk-…pq");
    expect(maskSecret("sk-planted-Q7xZ9mK2pL4vN8rT")).toBe("sk-…rT");
    expect(maskSecret("sk-ant-api03-abcdefghijklmnopqrstuvYZ")).toBe("sk-a…YZ");
    expect(maskSecret("ghp_abcdefghijklmnopqrstuvwxyz0123Zq")).toBe("ghp_…Zq");
    expect(maskSecret("sk_live_abcdefghijklmnopqrst9Q")).toBe("sk_l…9Q");
  });

  test("never shows more than min(6, a quarter) of the value", () => {
    for (let len = 16; len <= 80; len++) {
      for (const prefix of ["sk-ant-", "ghp_", "x"]) {
        const value = (prefix + "q".repeat(len)).slice(0, len);
        const shown = maskSecret(value).replace("…", "").length;
        expect(shown).toBeLessThanOrEqual(Math.min(6, Math.floor(len * 0.25)));
      }
    }
  });
});
