export interface Provider {
  name: string;
  pathPrefix: string;
  upstream: { host: string; port?: number; protocol: "https" | "http" };
  applyAuth: (headers: Record<string, string | string[] | undefined>, key: string) => void;
  isRateLimit: (status: number) => boolean;
  isAuthError: (status: number) => boolean;
}

const bearerAuth = (headers: Record<string, string | string[] | undefined>, key: string) => {
  headers["authorization"] = `Bearer ${key}`;
};

const xApiKeyAuth = (headers: Record<string, string | string[] | undefined>, key: string) => {
  headers["x-api-key"] = key;
};

export const PROVIDERS: Provider[] = [
  {
    name: "openai",
    pathPrefix: "/openai",
    upstream: { host: "api.openai.com", protocol: "https" },
    applyAuth: bearerAuth,
    isRateLimit: (s) => s === 429,
    isAuthError: (s) => s === 401,
  },
  {
    name: "anthropic",
    pathPrefix: "/anthropic",
    upstream: { host: "api.anthropic.com", protocol: "https" },
    applyAuth: xApiKeyAuth,
    isRateLimit: (s) => s === 429 || s === 529,
    isAuthError: (s) => s === 401,
  },
  {
    name: "groq",
    pathPrefix: "/groq",
    upstream: { host: "api.groq.com", protocol: "https" },
    applyAuth: bearerAuth,
    isRateLimit: (s) => s === 429,
    isAuthError: (s) => s === 401,
  },
  {
    name: "openrouter",
    pathPrefix: "/openrouter",
    upstream: { host: "openrouter.ai", protocol: "https" },
    applyAuth: bearerAuth,
    isRateLimit: (s) => s === 429,
    isAuthError: (s) => s === 401,
  },
];

export function matchProvider(reqPath: string): { provider: Provider; rest: string } | null {
  for (const p of PROVIDERS) {
    if (reqPath === p.pathPrefix || reqPath.startsWith(p.pathPrefix + "/")) {
      return { provider: p, rest: reqPath.slice(p.pathPrefix.length) || "/" };
    }
  }
  return null;
}
