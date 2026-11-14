const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const MARKER = "AGENTPASSv1x";

// Key shapes some CLIs check before sending; the whole token, prefix included, becomes the real value.
export const KEY_PREFIXES = [
  "sk-",
  "sk-ant-api03-",
  "sk-proj-",
  "sk_test_",
  "sk_live_",
  "rk_live_",
  "ghp_",
  "github_pat_",
  "gsk_",
  "sk-or-v1-",
  "hf_",
  "xoxb-",
  "AIza",
  "glpat-",
  "npm_",
];

// a key/base64 character on either side means the text is part of a larger token, not a placeholder
const TOKEN_CHAR = "[A-Za-z0-9_.+/=-]";
const PLACEHOLDER_RE = new RegExp(
  `\\{\\{secret:([A-Za-z0-9_.-]+)\\}\\}|(?<!${TOKEN_CHAR})(?:${KEY_PREFIXES.join("|")})?${MARKER}([0-9a-f]+)x(?!${TOKEN_CHAR})`,
  "g"
);

export interface PlaceholderMatch {
  start: number;
  end: number;
  name: string;
}

export function makePlaceholder(name: string, prefix = ""): string {
  if (!NAME_RE.test(name)) throw new Error(`Invalid secret name: ${JSON.stringify(name)}`);
  if (prefix && !KEY_PREFIXES.includes(prefix)) throw new Error(`Unknown key prefix: ${JSON.stringify(prefix)}`);
  return `${prefix}${MARKER}${Buffer.from(name, "latin1").toString("hex")}x`;
}

function decodeName(hex: string): string | null {
  if (hex.length % 2 !== 0) return null;
  const name = Buffer.from(hex, "hex").toString("latin1");
  return NAME_RE.test(name) ? name : null;
}

export function findPlaceholders(value: string): PlaceholderMatch[] {
  return [...value.matchAll(PLACEHOLDER_RE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    // an undecodable token keeps its own text as the name, so it fails as a missing secret
    name: match[1] ?? decodeName(match[2]!) ?? match[0],
  }));
}

export async function replacePlaceholders(
  value: string,
  resolve: (name: string) => Promise<string | null>
): Promise<{ value: string; found: string[]; missing: string[] }> {
  const found: string[] = [];
  const missing: string[] = [];
  let output = "";
  let cursor = 0;

  for (const { start, end, name } of findPlaceholders(value)) {
    found.push(name);
    const secret = await resolve(name);
    if (!secret) missing.push(name);
    output += value.slice(cursor, start) + (secret || value.slice(start, end));
    cursor = end;
  }

  return { value: output + value.slice(cursor), found, missing };
}
