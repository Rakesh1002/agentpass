import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import http from "http";
import https from "https";
import net from "net";
import tls from "tls";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Vault, vault as sharedVault } from "./vault";
import { appendAudit, listAudit } from "./audit";
import { certificateAuthority } from "./ca";
import { caCertFile } from "./paths";
import { ProxyServer, substitutePlaceholders } from "./proxy";

let testHome: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "agentpass-"));
  process.env.AGENTPASS_HOME = testHome;
});

afterEach(() => {
  sharedVault.close();
  delete process.env.AGENTPASS_HOME;
  rmSync(testHome, { recursive: true, force: true });
});

describe("vault", () => {
  test("encrypts secrets and rejects the wrong password", async () => {
    const vault = new Vault();
    await vault.init("correct-password");
    await vault.add("openai", "sk-test");
    expect(await vault.get("openai")).toBe("sk-test");
    vault.close();

    const reopened = new Vault();
    await expect(reopened.init("wrong-password")).rejects.toThrow("Invalid master password");
  });
});

describe("placeholder substitution", () => {
  test("replaces configured credential headers and reports missing secrets", async () => {
    const result = await substitutePlaceholders(
      {
        authorization: "Bearer {{secret:openai}}",
        "x-api-key": "{{secret:missing}}",
        "content-type": "application/json",
      },
      async (name) => (name === "openai" ? "sk-test" : null)
    );

    expect(result.headers.authorization).toBe("Bearer sk-test");
    expect(result.headers["x-api-key"]).toBe("{{secret:missing}}");
    expect(result.secretNames).toEqual(["openai", "missing"]);
    expect(result.missingSecrets).toEqual(["missing"]);
  });
});

describe("audit log", () => {
  test("persists proxy audit events without secret values", () => {
    appendAudit({
      method: "GET",
      destination: "api.openai.com:443",
      secretNames: ["openai"],
      statusCode: 200,
      durationMs: 12,
    });

    const rows = listAudit(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.destination).toBe("api.openai.com:443");
    expect(rows[0]?.secretNames).toEqual(["openai"]);
    expect(JSON.stringify(rows[0])).not.toContain("sk-test");
  });
});

describe("HTTPS proxy", () => {
  test("substitutes credential placeholders for direct proxy requests", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("openai", "sk-test");
    let observedAuthorization = "";

    const target = http.createServer((req, res) => {
      observedAuthorization = String(req.headers.authorization || "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Target server did not bind to a TCP port");
    }

    const proxy = new ProxyServer({ port: 0, rejectUnauthorized: false });
    await proxy.start();

    const response = await requestThroughDirectProxy(proxy.getPort(), targetAddress.port);

    expect(response).toContain("200 OK");
    expect(response).toContain("ok");
    expect(observedAuthorization).toBe("Bearer sk-test");

    await proxy.stop();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  test("substitutes credential placeholders over HTTPS CONNECT tunnels", async () => {
    await sharedVault.init("correct-password");
    await sharedVault.add("openai", "sk-test");

    const targetCert = certificateAuthority.getHostCertificate("localhost");
    let observedAuthorization = "";

    const target = https.createServer(
      {
        cert: targetCert.cert,
        key: targetCert.key,
      },
      (req, res) => {
        observedAuthorization = String(req.headers.authorization || "");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }
    );

    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") {
      throw new Error("Target server did not bind to a TCP port");
    }

    const proxy = new ProxyServer({ port: 0, rejectUnauthorized: false });
    await proxy.start();

    const response = await requestThroughConnectTunnel(
      proxy.getPort(),
      targetAddress.port,
      readFileSync(caCertFile())
    );

    expect(response).toContain("200 OK");
    expect(response).toContain("ok");
    expect(observedAuthorization).toBe("Bearer sk-test");

    await proxy.stop();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });
});

async function requestThroughDirectProxy(proxyPort: number, targetPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: "GET",
        path: `http://127.0.0.1:${targetPort}/models`,
        headers: {
          authorization: "Bearer {{secret:openai}}",
          connection: "close",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk.toString("utf-8");
        });
        res.on("end", () => {
          resolve(`HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n\r\n${body}`);
        });
      }
    );
    req.once("error", reject);
    req.end();
  });
}

async function requestThroughConnectTunnel(
  proxyPort: number,
  targetPort: number,
  ca: Buffer
): Promise<string> {
  const socket = net.connect(proxyPort, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  socket.write(
    `CONNECT localhost:${targetPort} HTTP/1.1\r\nHost: localhost:${targetPort}\r\n\r\n`
  );

  await readUntil(socket, "\r\n\r\n");

  const tlsSocket = tls.connect({
    socket,
    servername: "localhost",
    ca,
    rejectUnauthorized: true,
  });

  await new Promise<void>((resolve, reject) => {
    tlsSocket.once("secureConnect", resolve);
    tlsSocket.once("error", reject);
  });

  tlsSocket.write(
    [
      "GET /models HTTP/1.1",
      `Host: localhost:${targetPort}`,
      "Authorization: Bearer {{secret:openai}}",
      "Connection: close",
      "",
      "",
    ].join("\r\n")
  );

  return readUntilEnd(tlsSocket);
}

function readUntil(socket: net.Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("utf-8");
      if (data.includes(marker)) {
        socket.off("data", onData);
        socket.off("error", reject);
        resolve(data);
      }
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function readUntilEnd(socket: tls.TLSSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf-8");
    });
    socket.once("end", () => resolve(data));
    socket.once("error", reject);
  });
}
