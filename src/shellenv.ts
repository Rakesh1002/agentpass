import { spawnSync } from "child_process";
import http from "http";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { certificateAuthority } from "./ca";
import { caBundleFile, caCertFile, daemonFile, globalConfigFile } from "./paths";
import { BASE_URLS, MANIFEST_NAME, UntrustedError, homeDir, resolveProject } from "./project";
import { PROVIDERS } from "./providers";
import { allowedFile } from "./trust";

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

// The hook warns about an unreviewed manifest and still applies global defaults; env and run refuse it.
export function buildEnv(dir: string, port = proxyPort(), { hook = false } = {}): Record<string, string> {
  const proxyUrl = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {};
  const project = resolveProject(dir);
  if (project.manifest && !project.trusted) {
    const untrusted = new UntrustedError(project.manifest);
    if (!hook) throw untrusted;
    project.warnings.push(untrusted.message);
  }
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

export function envOutput(dir: string, format: EnvFormat, hook = false): string {
  return formatEnv(buildEnv(dir, undefined, { hook }), format);
}

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function fishQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function formatEnv(env: Record<string, string>, format: EnvFormat): string {
  if (format === "json") return JSON.stringify(env, null, 2) + "\n";
  const names = Object.keys(env);
  // Each prior value is saved (an unset var stays unset) and _AGENTPASS_RESTORE puts it back; evaluating
  // the output again restores first, so a second eval never saves agentpass's own values.
  if (format === "fish") {
    const restore = names.map(
      (k) =>
        `if set -q __AGENTPASS_SAVED_${k}; set -gx ${k} $__AGENTPASS_SAVED_${k}; set -e __AGENTPASS_SAVED_${k}; else; set -e ${k}; end;`
    );
    return (
      [
        "if set -q _AGENTPASS_RESTORE; eval $_AGENTPASS_RESTORE; end;",
        ...names.map((k) => `set -q ${k}; and set -g __AGENTPASS_SAVED_${k} $${k};`),
        ...Object.entries(env).map(([k, v]) => `set -gx ${k} ${fishQuote(v)};`),
        `set -g AGENTPASS_EXPORTED ${fishQuote(names.join(" "))};`,
        `set -g _AGENTPASS_RESTORE ${fishQuote([...restore, "set -e AGENTPASS_EXPORTED; set -e _AGENTPASS_RESTORE;"].join(" "))};`,
      ].join("\n") + "\n"
    );
  }
  const restore = names.map(
    (k) =>
      `if [[ -n \${__AGENTPASS_SAVED_${k}+x} ]]; then export ${k}="$__AGENTPASS_SAVED_${k}"; unset __AGENTPASS_SAVED_${k}; else unset ${k}; fi;`
  );
  return (
    [
      'eval "${_AGENTPASS_RESTORE-}";',
      ...names.map((k) => `[[ -n \${${k}+x} ]] && __AGENTPASS_SAVED_${k}="$${k}";`),
      ...Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)};`),
      `AGENTPASS_EXPORTED=${shQuote(names.join(" "))};`,
      `_AGENTPASS_RESTORE=${shQuote([...restore, "unset AGENTPASS_EXPORTED _AGENTPASS_RESTORE;"].join(" "))};`,
    ].join("\n") + "\n"
  );
}

export function hookScript(shell: Shell, cmd: string[]): string {
  const quote = shell === "fish" ? fishQuote : shQuote;
  const run = cmd.map((s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : quote(s))).join(" ");
  // mtime + size so a same-second edit still changes the key.
  const statFmt = process.platform === "linux" ? "-c '%Y %s'" : "-f '%m %z'";
  const watched = [globalConfigFile(), daemonFile(), allowedFile()].map(quote).join(" ");
  // Same walk as project.ts over physical paths: stop at the git toplevel or HOME, never look above HOME.
  const home = homeDir();
  const prefix = home === "/" ? "/" : `${home}/`;

  if (shell === "fish") {
    const inHome = home ? `test (string sub -l ${[...prefix].length} -- "$d/") = ${quote(prefix)}` : "false";
    return `function __agentpass_hook --on-variable PWD --on-event fish_prompt
    set -l d (pwd -P)
    set -l m ''
    if ${inHome}
        while true
            if test -f "$d/${MANIFEST_NAME}"
                set m "$d/${MANIFEST_NAME}"
                break
            end
            if test -e "$d/.git" -o "$d" = ${quote(home ?? "")} -o -z "$d"
                break
            end
            set d (string replace -r '/[^/]*$' '' -- $d)
        end
    end
    set -l key ''
    if test -n "$m"
        set key "$m "(command stat ${statFmt} $m ${watched} 2>/dev/null | string join ' ')
    end
    test "$key" = "$__agentpass_key"; and return
    set -g __agentpass_key $key
    if set -q _AGENTPASS_RESTORE
        eval $_AGENTPASS_RESTORE
    end
    if test -n "$m"
        ${run} env --hook --shell fish --dir (string replace -r '[^/]*$' '' -- $m) | source
    end
end
__agentpass_hook
`;
  }

  const inHome = home ? `[[ "$d/" == ${quote(prefix)}* ]]` : "false";
  const fn = `_agentpass_hook() {
  local d="${shell === "zsh" ? "${PWD:A}" : "$(pwd -P)"}" m="" key="" out
  if ${inHome}; then
    while :; do
      if [[ -f "$d/${MANIFEST_NAME}" ]]; then m="$d/${MANIFEST_NAME}"; break; fi
      [[ -e "$d/.git" || "$d" == ${quote(home ?? "")} || -z "$d" ]] && break
      d="\${d%/*}"
    done
  fi
  [[ -n "$m" ]] && key="$m $(command stat ${statFmt} "$m" ${watched} 2>/dev/null)"
  [[ "$key" == "\${_AGENTPASS_KEY-}" ]] && return 0
  _AGENTPASS_KEY="$key"
  eval "\${_AGENTPASS_RESTORE-}"
  [[ -z "$m" ]] && return 0
  out="$(${run} env --hook --shell ${shell} --dir "\${m%/*}/")" && eval "$out"
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
