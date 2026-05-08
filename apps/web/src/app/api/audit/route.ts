export async function POST(request: Request) {
  try {
    const body = await request.json();
    const email = typeof body.email === "string" ? body.email.trim() : "";

    if (!email) {
      return Response.json({ error: "Email is required" }, { status: 400 });
    }

    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) {
      return Response.json(
        { error: "AI Gateway not configured" },
        { status: 503 }
      );
    }

    const res = await fetch(
      "https://gateway.ai.cloudflare.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content:
                "You are a cybersecurity assistant. Give ONE short, actionable security tip about API keys or AI agent credential management. Keep it under 120 characters.",
            },
            {
              role: "user",
              content: `Give a personalized security tip for ${email}. Make it relevant to AI agents and secret management.`,
            },
          ],
          max_tokens: 80,
          temperature: 0.7,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      console.error("AI Gateway error:", err);
      return Response.json(
        { error: "Failed to generate tip" },
        { status: 502 }
      );
    }

    const data = await res.json();
    const tip = data.choices?.[0]?.message?.content?.trim() || "";

    return Response.json({ tip });
  } catch (err) {
    console.error("Audit error:", err);
    return Response.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
