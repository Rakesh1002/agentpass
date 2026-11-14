import { PROVIDERS } from "./providers";

export interface Pin {
  host: string;
  methods?: string[];
  pathPrefix?: string;
}

export type EgressVerdict = "allow" | "wildcard" | "deny";

const HOST_RE = /^(\*|[a-z0-9_-]+(\.[a-z0-9_-]+)*)$/;
const METHOD_RE = /^[A-Z]+$/;

function normalizePath(path: string): string {
  return new URL(path, "http://pin.invalid").pathname;
}

export function validatePins(input: unknown): Pin[] {
  if (!Array.isArray(input)) throw new Error("Pins must be an array");
  return input.map((raw: Record<string, unknown>) => {
    const host = typeof raw?.host === "string" ? raw.host.trim().toLowerCase() : "";
    if (!HOST_RE.test(host)) throw new Error(`Invalid pin host: ${JSON.stringify(raw?.host)}`);
    const pin: Pin = { host };

    if (raw.methods !== undefined) {
      if (!Array.isArray(raw.methods) || raw.methods.length === 0) {
        throw new Error("Pin methods must be a non-empty array");
      }
      pin.methods = raw.methods.map((m) => {
        const method = String(m).trim().toUpperCase();
        if (!METHOD_RE.test(method)) throw new Error(`Invalid pin method: ${JSON.stringify(m)}`);
        return method;
      });
    }

    if (raw.pathPrefix !== undefined) {
      const prefix = raw.pathPrefix;
      if (typeof prefix !== "string" || !prefix.startsWith("/") || normalizePath(prefix) !== prefix) {
        throw new Error(`Invalid pin path prefix: ${JSON.stringify(prefix)}`);
      }
      pin.pathPrefix = prefix;
    }

    return pin;
  });
}

export function parseStoredPins(raw: string | null): Pin[] | null {
  if (raw === null) return null;
  try {
    return validatePins(JSON.parse(raw));
  } catch {
    // corrupt pins must not silently widen to the implicit provider pin
    return [];
  }
}

export function providerForSecret(name: string) {
  return PROVIDERS.find((p) => name === p.name || name.startsWith(`${p.name}-`));
}

export function effectivePins(name: string, stored: Pin[] | null): Pin[] {
  if (stored) return stored;
  const provider = providerForSecret(name);
  return provider ? [{ host: provider.upstream.host }] : [];
}

function pathAllowed(prefix: string, rawPath: string): boolean {
  const path = rawPath.split("?")[0] || "/";
  // dot segments, backslashes or absolute-form targets could resolve outside the prefix upstream
  if (normalizePath(path) !== path) return false;
  if (path === prefix) return true;
  return path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function pinAllows(pin: Pin, host: string, method: string, path: string): boolean {
  if (pin.host !== "*" && pin.host !== host) return false;
  if (pin.methods && !pin.methods.includes(method.toUpperCase())) return false;
  if (pin.pathPrefix && !pathAllowed(pin.pathPrefix, path)) return false;
  return true;
}

export function egressVerdict(
  name: string,
  stored: Pin[] | null,
  host: string,
  method: string,
  path: string
): EgressVerdict {
  const pins = effectivePins(name, stored);
  const target = host.toLowerCase();
  if (pins.some((p) => p.host !== "*" && pinAllows(p, target, method, path))) return "allow";
  if (pins.some((p) => p.host === "*" && pinAllows(p, target, method, path))) return "wildcard";
  return "deny";
}
