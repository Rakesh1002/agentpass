"use client";

import { motion } from "framer-motion";
import { Sparkles } from "lucide-react";

const STRIPE_URL = process.env.NEXT_PUBLIC_STRIPE_FOUNDER_URL || "";
const SLOTS_LEFT = process.env.NEXT_PUBLIC_FOUNDER_SLOTS_LEFT || "10";

export default function Founder() {
  if (!STRIPE_URL) return null;

  return (
    <section className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="rounded-2xl border border-accent/40 bg-gradient-to-br from-accent/10 to-transparent p-8 sm:p-10"
      >
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-accent">
          <Sparkles className="h-3.5 w-3.5" />
          Founder license · {SLOTS_LEFT} of 10 left
        </div>

        <h2 className="mt-4 text-3xl font-bold tracking-tight text-fg">
          $99 once. Free upgrades. Forever.
        </h2>

        <p className="mt-3 text-muted">
          Back the alpha and lock in lifetime access — every future release,
          every paid feature, every Teams seat-equivalent for your personal
          machines. No subscription, no renewal. We use the money to ship
          faster.
        </p>

        <ul className="mt-6 space-y-2 text-sm text-fg">
          <li className="flex items-start gap-2">
            <span className="text-accent">→</span>
            <span>Lifetime use of the local CLI + proxy</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-accent">→</span>
            <span>All future paid features: cloud sync, Teams, MCP outbound</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-accent">→</span>
            <span>Private alpha Discord access + direct line to the maintainer</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="text-accent">→</span>
            <span>Your name in <code className="font-mono">CONTRIBUTORS.md</code> if you want it</span>
          </li>
        </ul>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <a
            href={STRIPE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-bg transition-opacity hover:opacity-90"
          >
            Claim a founder slot — $99
          </a>
          <span className="text-xs text-muted">
            Stripe Checkout · 30-day refund if it doesn&apos;t ship by July 26
          </span>
        </div>
      </motion.div>
    </section>
  );
}
