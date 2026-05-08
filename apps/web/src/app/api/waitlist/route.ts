interface WaitlistEntry {
  email: string;
  created_at: string;
  ip_hash?: string;
  referrer?: string;
}

async function hashIp(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + "agentpass-salt-2026");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim() : "";

    if (!email || !email.includes("@")) {
      return Response.json({ error: "Valid email is required" }, { status: 400 });
    }

    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const ipHash = await hashIp(ip);
    const kv = (globalThis as any).AGENTPASS_KV;
    if (kv) {
      const key = `rate:${ipHash}`;
      const count = parseInt((await kv.get(key)) || "0", 10);
      if (count > 10) {
        return Response.json({ error: "Rate limited. Try again later." }, { status: 429 });
      }
      await kv.put(key, String(count + 1), { expirationTtl: 3600 });
    }

    const entry: WaitlistEntry = {
      email,
      created_at: new Date().toISOString(),
      ip_hash: ipHash,
      referrer: request.headers.get("referer") || undefined,
    };

    const db = (globalThis as any).DB;
    if (db) {
      await db
        .prepare(
          `INSERT INTO waitlist (email, created_at, ip_hash, referrer) VALUES (?, ?, ?, ?)`
        )
        .bind(entry.email, entry.created_at, entry.ip_hash, entry.referrer || null)
        .run();
    }

    return Response.json({ success: true, email: entry.email });
  } catch (err) {
    console.error("Waitlist error:", err);
    return Response.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
