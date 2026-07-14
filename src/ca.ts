import forge from "node-forge";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";
import { agentPassDir, caCertFile, caKeyFile, certDir } from "./paths";

interface PemPair {
  cert: string;
  key: string;
}

function serialNumber(): string {
  return forge.util.bytesToHex(forge.random.getBytesSync(16));
}

function isIpAddress(hostname: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(":");
}

const certCache = new Map<string, PemPair>();

export class CertificateAuthority {
  ensureCa(): PemPair {
    const certPath = caCertFile();
    const keyPath = caKeyFile();

    if (existsSync(certPath) && existsSync(keyPath)) {
      return {
        cert: readFileSync(certPath, "utf-8"),
        key: readFileSync(keyPath, "utf-8"),
      };
    }

    mkdirSync(agentPassDir(), { recursive: true });

    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serialNumber();
    cert.validity.notBefore = new Date();
    cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

    const attrs = [
      { name: "commonName", value: "AgentPass Local Proxy CA" },
      { name: "organizationName", value: "AgentPass" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true },
      { name: "keyUsage", keyCertSign: true, digitalSignature: true, cRLSign: true },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());

    const pair = {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };

    const tmpCert = `${certPath}.tmp`;
    const tmpKey = `${keyPath}.tmp`;
    writeFileSync(tmpCert, pair.cert, { mode: 0o644 });
    writeFileSync(tmpKey, pair.key, { mode: 0o600 });
    renameSync(tmpCert, certPath);
    renameSync(tmpKey, keyPath);
    return pair;
  }

  certPath(): string {
    this.ensureCa();
    return caCertFile();
  }

  getHostCertificate(hostname: string): PemPair {
    const normalizedHost = hostname.toLowerCase();

    if (certCache.has(normalizedHost)) return certCache.get(normalizedHost)!;

    const safeName = normalizedHost.replace(/[^a-z0-9.-]/gi, "_");
    const hostCertPath = resolve(certDir(), `${safeName}.crt`);
    const hostKeyPath = resolve(certDir(), `${safeName}.key`);

    if (existsSync(hostCertPath) && existsSync(hostKeyPath)) {
      const pair = {
        cert: readFileSync(hostCertPath, "utf-8"),
        key: readFileSync(hostKeyPath, "utf-8"),
      };
      certCache.set(normalizedHost, pair);
      return pair;
    }

    const ca = this.ensureCa();
    mkdirSync(certDir(), { recursive: true });

    const caCert = forge.pki.certificateFromPem(ca.cert);
    const caKey = forge.pki.privateKeyFromPem(ca.key);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serialNumber();
    cert.validity.notBefore = new Date();
    cert.validity.notBefore.setDate(cert.validity.notBefore.getDate() - 1);
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    cert.setSubject([{ name: "commonName", value: normalizedHost }]);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          isIpAddress(normalizedHost)
            ? { type: 7, ip: normalizedHost }
            : { type: 2, value: normalizedHost },
        ],
      },
    ]);
    cert.sign(caKey, forge.md.sha256.create());

    const pair = {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey),
    };

    const tmpHostCert = `${hostCertPath}.tmp`;
    const tmpHostKey = `${hostKeyPath}.tmp`;
    writeFileSync(tmpHostCert, pair.cert, { mode: 0o644 });
    writeFileSync(tmpHostKey, pair.key, { mode: 0o600 });
    renameSync(tmpHostCert, hostCertPath);
    renameSync(tmpHostKey, hostKeyPath);
    certCache.set(normalizedHost, pair);
    return pair;
  }
}

export const certificateAuthority = new CertificateAuthority();
