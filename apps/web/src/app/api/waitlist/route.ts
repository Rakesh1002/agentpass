import { getCloudflareContext } from "@opennextjs/cloudflare";

declare global {
  interface CloudflareEnv {
    DB?: {
      prepare(query: string): { bind(...values: unknown[]): { run(): Promise<unknown> } };
    };
    AGENTPASS_KV?: {
      get(key: string): Promise<string | null>;
      put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    };
    WAITLIST_IP_SALT?: string;
  }
}

async function hashIp(ip: string, salt: string | undefined): Promise<string> {
  if (!salt) {
    throw new Error("WAITLIST_IP_SALT is not configured");
  }
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + salt);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  try {
    const { env } = getCloudflareContext();
    const db = env.DB;
    if (!db) {
      console.error("Waitlist error: D1 binding DB is missing");
      return Response.json({ error: "Signups are unavailable right now." }, { status: 500 });
    }

    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim() : "";

    if (!email || !email.includes("@")) {
      return Response.json({ error: "Valid email is required" }, { status: 400 });
    }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const ipHash = await hashIp(ip, env.WAITLIST_IP_SALT);
    const kv = env.AGENTPASS_KV;
    if (kv) {
      const key = `rate:${ipHash}`;
      const count = parseInt((await kv.get(key)) || "0", 10);
      if (count > 10) {
        return Response.json({ error: "Rate limited. Try again later." }, { status: 429 });
      }
      await kv.put(key, String(count + 1), { expirationTtl: 3600 });
    }

    await db
      .prepare(`INSERT INTO waitlist (email, created_at, ip_hash, referrer) VALUES (?, ?, ?, ?)`)
      .bind(email, new Date().toISOString(), ipHash, request.headers.get("referer") || null)
      .run();

    return Response.json({ success: true, email });
  } catch (err) {
    console.error("Waitlist error:", err);
    return Response.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
