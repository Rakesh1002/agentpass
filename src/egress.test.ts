import { describe, expect, test } from "bun:test";
import { effectivePins, egressVerdict, isLoopbackHost, parseStoredPins, validatePins } from "./egress";
import { KNOWN_SERVICES } from "./providers";

describe("egress pins", () => {
  test("allows only the exact pinned host, case-insensitively", () => {
    const pins = [{ host: "api.stripe.com" }];
    expect(egressVerdict("stripe", pins, "api.stripe.com", "GET", "/v1/charges")).toBe("allow");
    expect(egressVerdict("stripe", pins, "API.Stripe.com", "GET", "/")).toBe("allow");
    expect(egressVerdict("stripe", pins, "evil.example", "GET", "/")).toBe("deny");
    expect(egressVerdict("stripe", pins, "api.stripe.com.evil.example", "GET", "/")).toBe("deny");
    expect(egressVerdict("stripe", pins, "stripe.com", "GET", "/")).toBe("deny");
  });

  test("enforces method and path-prefix constraints on segment boundaries", () => {
    const pins = [{ host: "api.stripe.com", methods: ["POST"], pathPrefix: "/v1/charges" }];
    expect(egressVerdict("stripe", pins, "api.stripe.com", "post", "/v1/charges")).toBe("allow");
    expect(egressVerdict("stripe", pins, "api.stripe.com", "POST", "/v1/charges/ch_1?x=1")).toBe("allow");
    expect(egressVerdict("stripe", pins, "api.stripe.com", "GET", "/v1/charges")).toBe("deny");
    expect(egressVerdict("stripe", pins, "api.stripe.com", "POST", "/v1/chargesadmin")).toBe("deny");
    expect(egressVerdict("stripe", pins, "api.stripe.com", "POST", "/v1/customers")).toBe("deny");
  });

  test("rejects paths that could resolve outside the pinned prefix", () => {
    const pins = [{ host: "api.stripe.com", pathPrefix: "/v1/charges" }];
    expect(egressVerdict("stripe", pins, "api.stripe.com", "GET", "/v1/charges/../customers")).toBe("deny");
    expect(egressVerdict("stripe", pins, "api.stripe.com", "GET", "/v1/charges/%2e%2e/customers")).toBe("deny");
    expect(egressVerdict("stripe", pins, "api.stripe.com", "GET", "/v1/charges\\..\\customers")).toBe("deny");
    expect(egressVerdict("stripe", pins, "api.stripe.com", "GET", "https://evil.example/v1/charges")).toBe("deny");
  });

  test("denies encoded separators and NUL in the path under a path pin", () => {
    const pins = [{ host: "api.stripe.com", pathPrefix: "/v1/charges" }];
    for (const path of [
      "/v1/charges/..%2fcustomers",
      "/v1/charges/..%2Fcustomers",
      "/v1/charges/..%5ccustomers",
      "/v1/charges/..%5Ccustomers",
      "/v1/charges/ch_1%00",
    ]) {
      expect(egressVerdict("stripe", pins, "api.stripe.com", "GET", path)).toBe("deny");
    }
    expect(egressVerdict("stripe", pins, "api.stripe.com", "GET", "/v1/charges/ch_1?next=%2Fdone")).toBe("allow");
    expect(egressVerdict("stripe", [{ host: "api.stripe.com" }], "api.stripe.com", "GET", "/v1/a%2Fb")).toBe("allow");
  });

  test("denies by default when a secret has no pins", () => {
    expect(effectivePins("stripe", null)).toEqual([]);
    expect(egressVerdict("stripe", null, "api.stripe.com", "GET", "/")).toBe("deny");
  });

  test("implicitly pins provider-named secrets to the provider host", () => {
    expect(effectivePins("openai", null)).toEqual([{ host: "api.openai.com" }]);
    expect(effectivePins("anthropic-clienta", null)).toEqual([{ host: "api.anthropic.com" }]);
    expect(effectivePins("openai2", null)).toEqual([]);
    expect(egressVerdict("openai-2", null, "api.openai.com", "POST", "/v1/chat/completions")).toBe("allow");
    expect(egressVerdict("openai-2", null, "evil.example", "POST", "/")).toBe("deny");
  });

  test("explicit pins replace the implicit provider pin", () => {
    const pins = [{ host: "api.openai.com", methods: ["GET"] }];
    expect(effectivePins("openai", pins)).toEqual(pins);
    expect(egressVerdict("openai", pins, "api.openai.com", "POST", "/v1/chat/completions")).toBe("deny");
  });

  test("reports a wildcard pin separately from an exact match", () => {
    const pins = [{ host: "api.stripe.com" }, { host: "*" }];
    expect(egressVerdict("stripe", pins, "api.stripe.com", "GET", "/")).toBe("allow");
    expect(egressVerdict("stripe", pins, "anything.example", "GET", "/")).toBe("wildcard");
  });

  test("validates and normalizes pins", () => {
    expect(validatePins([{ host: " API.Stripe.com ", methods: ["get"], pathPrefix: "/v1" }])).toEqual([
      { host: "api.stripe.com", methods: ["GET"], pathPrefix: "/v1" },
    ]);
    expect(() => validatePins([{ host: "https://api.stripe.com" }])).toThrow();
    expect(() => validatePins([{ host: "*.stripe.com" }])).toThrow();
    expect(() => validatePins([{ host: "api.stripe.com:443" }])).toThrow();
    expect(() => validatePins([{ host: "" }])).toThrow();
    expect(() => validatePins([{ host: "a.com", methods: ["GET POST"] }])).toThrow();
    expect(() => validatePins([{ host: "a.com", methods: [] }])).toThrow();
    expect(() => validatePins([{ host: "a.com", pathPrefix: "v1" }])).toThrow();
    expect(() => validatePins([{ host: "a.com", pathPrefix: "/v1/../admin" }])).toThrow();
    expect(() => validatePins({ host: "a.com" })).toThrow();
  });

  test("treats corrupt stored pins as deny-all instead of falling back to implicit", () => {
    expect(parseStoredPins(null)).toBeNull();
    expect(parseStoredPins("not json")).toEqual([]);
    expect(parseStoredPins(JSON.stringify([{ host: "https://x" }]))).toEqual([]);
    expect(egressVerdict("openai", parseStoredPins("not json"), "api.openai.com", "GET", "/")).toBe("deny");
  });

  test("recognizes only loopback hosts as safe for cleartext", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["128.0.0.1", "10.0.0.1", "api.stripe.com", "localhost.evil.example", "127.0.0.1.evil.example", "::2"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  test("exports well-known service hosts", () => {
    expect(KNOWN_SERVICES.stripe).toBe("api.stripe.com");
    expect(KNOWN_SERVICES.github).toBe("api.github.com");
    expect(KNOWN_SERVICES.openai).toBe("api.openai.com");
    expect(KNOWN_SERVICES.anthropic).toBe("api.anthropic.com");
    expect(KNOWN_SERVICES.gemini).toBe("generativelanguage.googleapis.com");
    expect(KNOWN_SERVICES.google).toBe("generativelanguage.googleapis.com");
  });
});
