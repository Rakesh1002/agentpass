"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Mail, CheckCircle, Loader2, Zap } from "lucide-react";

export default function Waitlist() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [tip, setTip] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || status === "loading") return;

    setStatus("loading");
    setErrorMsg("");
    setTip("");

    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong");
      }

      setStatus("success");

      try {
        const auditRes = await fetch("/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        const auditData = await auditRes.json();
        if (auditData.tip) setTip(auditData.tip);
      } catch {
        // Non-blocking
      }
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Failed to join waitlist");
    }
  }

  return (
    <section id="waitlist" className="mx-auto max-w-2xl px-4 py-20 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="rounded-2xl border border-border bg-card p-8 sm:p-10"
      >
        <div className="text-center">
          <div className="mx-auto inline-flex rounded-lg bg-accent/10 p-2 text-accent mb-4">
            <Mail className="h-5 w-5" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight text-fg">
            Join the waitlist
          </h2>
          <p className="mt-2 text-muted">
            Be the first to get AgentPass. No spam — just a heads up when the
            CLI drops.
          </p>
        </div>

        {status === "success" ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-8 text-center"
          >
            <div className="inline-flex items-center gap-2 rounded-lg bg-accent/10 px-4 py-3 text-accent">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">You are on the list — thanks!</span>
            </div>
            {tip && (
              <div className="mt-4 rounded-lg border border-accent/20 bg-accent/5 px-4 py-3 text-sm text-accent">
                <Zap className="inline h-4 w-4 mr-1 -mt-0.5" />
                {tip}
              </div>
            )}
          </motion.div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-8">
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="flex-1 rounded-lg border border-border bg-bg px-4 py-3 text-sm text-fg placeholder:text-muted outline-none transition-colors focus:border-accent"
              />
              <button
                type="submit"
                disabled={status === "loading"}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {status === "loading" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Join"
                )}
              </button>
            </div>
            {status === "error" && (
              <p className="mt-3 text-sm text-red-400">{errorMsg}</p>
            )}
          </form>
        )}
      </motion.div>
    </section>
  );
}
