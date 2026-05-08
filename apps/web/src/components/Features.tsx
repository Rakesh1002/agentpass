"use client";

import { motion } from "framer-motion";
import { Lock, RefreshCw, Globe, Terminal, ArrowRight } from "lucide-react";

const features = [
  {
    icon: Lock,
    title: "Encrypted local vault",
    description:
      "AES-256-GCM encryption with PBKDF2 key derivation. Your secrets never leave your machine unless you explicitly sync them.",
  },
  {
    icon: RefreshCw,
    title: "Auto-rotation handling",
    description:
      "Detects when an API key is rotated and replays the request with the new key — your agents never break.",
  },
  {
    icon: Globe,
    title: "HTTP proxy injection",
    description:
      "Intercepts outgoing requests and substitutes {{secret:name}} placeholders with real credentials at the network layer.",
  },
  {
    icon: Terminal,
    title: "CLI-first for Claude Code",
    description:
      "One-line install via Bun. Drop-in shim for Claude Code, Cursor, OpenClaw, and any MCP-native agent runtime.",
  },
];

export default function Features() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {features.map((feature, i) => (
          <motion.div
            key={feature.title}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: i * 0.1 }}
            className="group relative rounded-xl border border-border bg-card p-6 transition-colors hover:border-accent/20 hover:bg-card-hover"
          >
            <div className="mb-4 inline-flex rounded-lg bg-accent/10 p-2 text-accent">
              <feature.icon className="h-5 w-5" />
            </div>
            <h3 className="text-base font-semibold text-fg">{feature.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              {feature.description}
            </p>
          </motion.div>
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
        className="mt-20"
      >
        <h2 className="text-center text-2xl font-bold tracking-tight text-fg">
          How it works
        </h2>

        <div className="mx-auto mt-10 flex max-w-3xl flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-card">
              <Terminal className="h-6 w-6 text-accent" />
            </div>
            <span className="text-sm font-medium text-fg">AI Agent</span>
            <span className="text-xs text-muted">Claude Code / Cursor</span>
          </div>

          <div className="flex flex-col items-center gap-1">
            <ArrowRight className="hidden h-5 w-5 text-muted sm:block" />
            <span className="text-xs text-muted sm:hidden">↓</span>
            <span className="text-xs text-accent">HTTP Proxy</span>
          </div>

          <div className="flex flex-col items-center gap-2 text-center">
            <div className="relative flex h-16 w-16 items-center justify-center rounded-xl border border-accent/30 bg-accent/5">
              <Lock className="h-6 w-6 text-accent" />
              <div className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-bg">
                🔐
              </div>
            </div>
            <span className="text-sm font-medium text-fg">AgentPass</span>
            <span className="text-xs text-muted">Vault + Proxy</span>
          </div>

          <div className="flex flex-col items-center gap-1">
            <ArrowRight className="hidden h-5 w-5 text-muted sm:block" />
            <span className="text-xs text-muted sm:hidden">↓</span>
            <span className="text-xs text-accent">Real key injected</span>
          </div>

          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-card">
              <Globe className="h-6 w-6 text-muted" />
            </div>
            <span className="text-sm font-medium text-fg">External API</span>
            <span className="text-xs text-muted">OpenAI, Stripe, etc</span>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
