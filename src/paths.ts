import { resolve } from "path";

export function agentPassDir(): string {
  return resolve(process.env.AGENTPASS_HOME || resolve(process.env.HOME || ".", ".agentpass"));
}

export function vaultFile(): string {
  return resolve(agentPassDir(), "vault.db");
}

export function saltFile(): string {
  return resolve(agentPassDir(), "vault.salt");
}

export function auditFile(): string {
  return resolve(agentPassDir(), "audit.db");
}

export function caCertFile(): string {
  return resolve(agentPassDir(), "agentpass-ca.crt");
}

export function caKeyFile(): string {
  return resolve(agentPassDir(), "agentpass-ca.key");
}

export function certDir(): string {
  return resolve(agentPassDir(), "certs");
}
