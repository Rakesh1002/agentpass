import { spawnSync } from "child_process";
import http from "http";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { certificateAuthority } from "./ca";
import { caBundleFile, caCertFile, daemonFile, globalConfigFile } from "./paths";
import { BASE_URLS, MANIFEST_NAME, resolveProject } from "./project";
import { PROVIDERS } from "./providers";

export type Shell = "bash" | "zsh" | "fish";
export type EnvFormat = Shell | "json";

const DEFAULT_PORT = 8888;
const NO_PROXY = "localhost,127.0.0.1,::1";
const LINUX_ROOTS = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/cert.pem"];

export function proxyPort(): number {
  try {
    const port = JSON.parse(readFileSync(daemonFile(), "utf-8")).port;
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {}
  return DEFAULT_PORT;
}

function systemRoots(): string | null {
  if (process.platform === "darwin") {
    const r = spawnSync(
      "security",
      ["find-certificate", "-a", "-p", "/System/Library/Keychains/SystemRootCertificates.keychain"],
      { encoding: "utf-8" }
    );
    return r.status === 0 && r.stdout.includes("BEGIN CERTIFICATE") ? r.stdout : null;
  }
  const file = LINUX_ROOTS.find((f) => existsSync(f));
  return file ? readFileSync(file, "utf-8") : null;
}

export function ensureCaBundle(readRoots: () => string | null = systemRoots): string | null {
  const bundle = caBundleFile();
  const ca = certificateAuthority.certPath();
  if (existsSync(bundle) && statSync(bundle).mtimeMs >= statSync(ca).mtimeMs) return bundle;
  const roots = readRoots();
  // Without system roots, SSL_CERT_FILE would break every non-intercepted TLS host.
  if (!roots) return null;
  const tmp = `${bundle}.tmp`;
  writeFileSync(tmp, `${roots.endsWith("\n") ? roots : roots + "\n"}${readFileSync(ca, "utf-8")}`, { mode: 0o644 });
  renameSync(tmp, bundle);
  return bundle;
}

export function proxyReachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/_/health", timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

export function buildEnv(dir: string, port = proxyPort()): Record<string, string> {
  const proxyUrl = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {};
  const project = resolveProject(dir);
  for (const warning of project.warnings) console.error(`agentpass: ${warning}`);
  for (const [name, { secret }] of Object.entries(project.env)) {
    env[name] = `{{secret:${secret}}}`;
    const provider = PROVIDERS.find((p) => p.name === secret.split("-")[0]);
    const base = provider && BASE_URLS[provider.name];
    if (provider && base) env[base.env] = `${proxyUrl}${provider.pathPrefix}${base.path}`;
  }
  Object.assign(env, {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY,
    no_proxy: NO_PROXY,
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: caCertFile(),
  });
  const bundle = ensureCaBundle();
  if (bundle) Object.assign(env, { SSL_CERT_FILE: bundle, REQUESTS_CA_BUNDLE: bundle });
  return env;
}

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fishQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function formatEnv(env: Record<string, string>, format: EnvFormat): string {
  if (format === "json") return JSON.stringify(env, null, 2) + "\n";
  const names = Object.keys(env).join(" ");
  if (format === "fish") {
    const lines = Object.entries(env).map(([k, v]) => `set -gx ${k} ${fishQuote(v)};`);
    return [...lines, `set -g AGENTPASS_EXPORTED ${fishQuote(names)};`].join("\n") + "\n";
  }
  const lines = Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)};`);
  return [...lines, `AGENTPASS_EXPORTED=${shQuote(names)};`].join("\n") + "\n";
}

export function hookScript(shell: Shell, cmd: string[]): string {
  const quote = shell === "fish" ? fishQuote : shQuote;
  const run = cmd.map((s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : quote(s))).join(" ");
  // mtime + size so a same-second edit still changes the key.
  const statFmt = process.platform === "linux" ? "-c '%Y %s'" : "-f '%m %z'";
  const watched = [globalConfigFile(), daemonFile()].map(quote).join(" ");

  if (shell === "fish") {
    return `function __agentpass_hook --on-variable PWD --on-event fish_prompt
    set -l d $PWD
    set -l m ''
    while true
        if test -f "$d/${MANIFEST_NAME}"
            set m "$d/${MANIFEST_NAME}"
            break
        end
        if test -z "$d" -o "$d" = /
            break
        end
        set d (string replace -r '/[^/]*$' '' -- $d)
    end
    set -l key ''
    if test -n "$m"
        set key "$m "(command stat ${statFmt} $m ${watched} 2>/dev/null | string join ' ')
    end
    test "$key" = "$__agentpass_key"; and return
    set -g __agentpass_key $key
    for v in (string split -n ' ' -- "$AGENTPASS_EXPORTED")
        set -e $v
    end
    set -e AGENTPASS_EXPORTED
    if test -n "$m"
        ${run} env --shell fish --dir (string replace -r '[^/]*$' '' -- $m) | source
    end
end
__agentpass_hook
`;
  }

  const split = shell === "zsh" ? "${=AGENTPASS_EXPORTED}" : "${AGENTPASS_EXPORTED-}";
  const fn = `_agentpass_hook() {
  local d="$PWD" m="" key="" out v
  while :; do
    if [[ -f "$d/${MANIFEST_NAME}" ]]; then m="$d/${MANIFEST_NAME}"; break; fi
    [[ -z "$d" || "$d" == / ]] && break
    d="\${d%/*}"
  done
  [[ -n "$m" ]] && key="$m $(command stat ${statFmt} "$m" ${watched} 2>/dev/null)"
  [[ "$key" == "\${_AGENTPASS_KEY-}" ]] && return 0
  _AGENTPASS_KEY="$key"
  for v in ${split}; do unset "$v"; done
  unset AGENTPASS_EXPORTED
  [[ -z "$m" ]] && return 0
  out="$(${run} env --shell ${shell} --dir "\${m%/*}/")" && eval "$out"
}
`;
  if (shell === "zsh") {
    return `${fn}autoload -Uz add-zsh-hook
add-zsh-hook chpwd _agentpass_hook
add-zsh-hook precmd _agentpass_hook
_agentpass_hook
`;
  }
  return `${fn}if [[ ";\${PROMPT_COMMAND[*]:-};" != *";_agentpass_hook;"* ]]; then
  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(_agentpass_hook "\${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="_agentpass_hook\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  fi
fi
_agentpass_hook
`;
}
