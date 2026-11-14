import { PROVIDERS } from "./providers";

export interface Pin {
  host: string;
  methods?: string[];
  pathPrefix?: string;
}

export type EgressVerdict = "allow" | "wildcard" | "deny";
export type Scheme = "http" | "https";

const NAME_RE = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const IPV6_RE = /^\[[0-9a-f:.]+\]$/;
const METHOD_RE = /^[A-Z]+$/;
const DEFAULT_PORTS: Record<Scheme, number> = { http: 80, https: 443 };

function normalizePath(path: string): string {
  return new URL(path, "http://pin.invalid").pathname;
}

// lowercased, IPv4 in dotted form, IPv6 compressed and bracketed; null if not a plain host
function canonicalHost(raw: string): string | null {
  const host = raw.toLowerCase();
  if (!NAME_RE.test(host) && !IPV6_RE.test(host)) return null;
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

// host, host:port or [v6]:port; a "*" host (and a "*" port on it) only when wild
function splitAuthority(raw: string, wild: boolean): { host: string; port: number | "*" | null } | null {
  const match = /^(\[[^\]]*\]|[^:[\]]*)(?::([^:]*))?$/.exec(raw);
  if (!match) return null;
  const [, rawHost = "", rawPort] = match;
  const host = wild && rawHost === "*" ? "*" : canonicalHost(rawHost);
  if (!host) return null;
  if (rawPort === undefined) return { host, port: null };
  if (host === "*" && rawPort === "*") return { host, port: "*" };
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : 0;
  return port >= 1 && port <= 65535 ? { host, port } : null;
}

export function parseAuthority(raw: string): { host: string; port: number | null } | null {
  const authority = splitAuthority(raw, false);
  return authority && authority.port !== "*" ? { host: authority.host, port: authority.port } : null;
}

export function validatePins(input: unknown): Pin[] {
  if (!Array.isArray(input)) throw new Error("Pins must be an array");
  return input.map((raw: Record<string, unknown>) => {
    const authority = typeof raw?.host === "string" ? splitAuthority(raw.host.trim(), true) : null;
    if (!authority) throw new Error(`Invalid pin host: ${JSON.stringify(raw?.host)}`);
    const pin: Pin = { host: authority.port === null ? authority.host : `${authority.host}:${authority.port}` };

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

// sockets and DNS want an IPv6 literal without the URL brackets
export function unbracket(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1");
}

export function isLoopbackHost(host: string): boolean {
  const h = unbracket(host.toLowerCase());
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

// wider than isLoopbackHost: every spelling that can reach a listener on this machine
export function isLocalHost(host: string): boolean {
  const h = unbracket(host.toLowerCase()).replace(/\.$/, "");
  if (isLoopbackHost(h) || h.endsWith(".localhost") || h === "::" || /^0(\.\d{1,3}){3}$/.test(h)) return true;
  const embedded = /^::(?:ffff:)?([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(h);
  return !!embedded && [0, 127].includes(parseInt(embedded[1]!, 16) >> 8);
}

// host must be canonical (as parseAuthority or URL.hostname returns it)
export function pinHostMatches(pinHost: string, host: string, port: number, defaultPort: number): boolean {
  const pin = splitAuthority(pinHost, true);
  if (!pin || (pin.host !== "*" && pin.host !== host)) return false;
  return pin.port === "*" || (pin.port ?? defaultPort) === port;
}

function pathAllowed(prefix: string, rawPath: string): boolean {
  const path = rawPath.split("?")[0] || "/";
  // dot segments, backslashes or absolute-form targets could resolve outside the prefix upstream
  if (normalizePath(path) !== path) return false;
  // servers that decode before routing would turn these into separators or truncate at NUL
  if (/%(2f|5c|00)/i.test(path)) return false;
  if (path === prefix) return true;
  return path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function pinAllows(pin: Pin, host: string, port: number, defaultPort: number, method: string, path: string): boolean {
  if (!pinHostMatches(pin.host, host, port, defaultPort)) return false;
  if (pin.methods && !pin.methods.includes(method.toUpperCase())) return false;
  if (pin.pathPrefix && !pathAllowed(pin.pathPrefix, path)) return false;
  return true;
}

// authority is host or host:port; without a port it means the scheme's default
export function egressVerdict(
  name: string,
  stored: Pin[] | null,
  authority: string,
  method: string,
  path: string,
  scheme: Scheme = "https"
): EgressVerdict {
  const target = parseAuthority(authority);
  if (!target) return "deny";
  const defaultPort = DEFAULT_PORTS[scheme];
  const port = target.port ?? defaultPort;
  // implicit provider pins are HTTPS endpoints, so they never cover another port
  const pins = stored ?? effectivePins(name, null).map((pin) => ({ ...pin, host: `${pin.host}:443` }));
  const allows = (p: Pin) => pinAllows(p, target.host, port, defaultPort, method, path);
  const isWildcard = (p: Pin) => p.host === "*" || p.host.startsWith("*:");
  if (pins.some((p) => !isWildcard(p) && allows(p))) return "allow";
  if (pins.some((p) => isWildcard(p) && allows(p))) return "wildcard";
  return "deny";
}
