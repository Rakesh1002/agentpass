// Prefixes that identify a key's issuer and carry no secret material.
const PUBLIC_PREFIXES = ["sk-ant-", "sk-proj-", "sk-", "sk_live_", "sk_test_", "rk_live_", "ghp_", "github_pat_", "xoxb-", "glpat-"];

export function maskSecret(value: string): string {
  if (value.length < 16) return "…";
  const budget = Math.min(6, Math.floor(value.length * 0.25));
  const tail = Math.min(2, budget);
  const prefix = Math.max(0, ...PUBLIC_PREFIXES.filter((p) => value.startsWith(p)).map((p) => p.length));
  const lead = Math.min(4, prefix, budget - tail);
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
