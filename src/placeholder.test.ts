import { describe, expect, test } from "bun:test";
import { findPlaceholders, KEY_PREFIXES, makePlaceholder, replacePlaceholders } from "./placeholder";

const hex = (name: string) => Buffer.from(name).toString("hex");

describe("placeholders", () => {
  test("round-trips a format-preserving placeholder for every allowed prefix", () => {
    for (const prefix of ["", ...KEY_PREFIXES]) {
      const token = makePlaceholder("openai-2.x_Y", prefix);
      expect(token).toBe(`${prefix}AGENTPASSv1x${hex("openai-2.x_Y")}x`);
      expect(findPlaceholders(token)).toEqual([{ start: 0, end: token.length, name: "openai-2.x_Y" }]);
      expect(findPlaceholders(`Bearer ${token}`)).toEqual([{ start: 7, end: 7 + token.length, name: "openai-2.x_Y" }]);
    }
  });

  test("keeps supporting the {{secret:NAME}} form", () => {
    expect(findPlaceholders("Bearer {{secret:openai}}")).toEqual([{ start: 7, end: 24, name: "openai" }]);
    expect(findPlaceholders(`{{secret:AGENTPASSv1x${hex("a")}x}}`)).toEqual([
      { start: 0, end: 26, name: `AGENTPASSv1x${hex("a")}x` },
    ]);
  });

  test("never matches text that is only part of a larger token", () => {
    const body = `AGENTPASSv1x${hex("openai")}x`;
    for (const value of [
      `sk-abc${body}`,
      `x${body}`,
      `${body}y`,
      `${body}=`,
      `a.${body}.b`,
      `sk-proj-abc/${body}`,
      `ghp_${body}_more`,
      `AGENTPASSv1X${hex("openai")}x`,
      `AGENTPASSv1x${hex("openai").toUpperCase()}x`,
      `AGENTPASSv2x${hex("openai")}x`,
      "AGENTPASSv1xx",
      `sk-proj-AGENTPASSv1x${hex("openai")}`,
      `SK-AGENTPASSv1x${hex("openai")}x`,
      "sk-proj-0123456789abcdefAGENTPASS",
      "{{secret:}}",
    ]) {
      expect(findPlaceholders(value)).toEqual([]);
    }
  });

  test("reports an undecodable token by its own text so it resolves as missing", () => {
    expect(findPlaceholders("AGENTPASSv1xffx")).toEqual([{ start: 0, end: 15, name: "AGENTPASSv1xffx" }]);
    expect(findPlaceholders("sk-AGENTPASSv1x6x")[0]?.name).toBe("sk-AGENTPASSv1x6x");
    expect(findPlaceholders("AGENTPASSv1x0a41x")[0]?.name).toBe("AGENTPASSv1x0a41x");
  });

  test("rejects unknown prefixes and invalid names", () => {
    expect(() => makePlaceholder("openai", "pk_live_")).toThrow("Unknown key prefix");
    expect(() => makePlaceholder("bad name")).toThrow("Invalid secret name");
    expect(() => makePlaceholder("")).toThrow("Invalid secret name");
  });

  test("substitutes each placeholder once, in place, and reports missing names", async () => {
    const value = `Bearer ${makePlaceholder("a", "sk-")} {{secret:b}} ${makePlaceholder("nope")}`;
    const result = await replacePlaceholders(value, async (name) =>
      name === "a" ? "real-a{{secret:b}}" : name === "b" ? "real-b" : null
    );
    expect(result.value).toBe(`Bearer real-a{{secret:b}} real-b ${makePlaceholder("nope")}`);
    expect(result.found).toEqual(["a", "b", "nope"]);
    expect(result.missing).toEqual(["nope"]);
  });
});
