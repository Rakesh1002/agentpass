"use client";

import { motion } from "framer-motion";
import { Layers, RefreshCw, Lock, Terminal, ArrowRight, Globe } from "lucide-react";

const features = [
  {
    icon: Layers,
    title: "Multi-key fallback",
    description:
      "Pool N keys per provider. On 429, AgentPass cools down the spent key, retries with the next one, and your agent keeps shipping.",
  },
  {
    icon: RefreshCw,
    title: "Transparent rotation",
    description:
      "On 401, AgentPass retries with the next key in the pool. Drop the new key into the vault and the next request finds it — no agent restart.",
  },
  {
    icon: Lock,
    title: "Agent never sees the key",
    description:
      "The proxy injects auth at the network layer. The raw key sits in your encrypted local vault — not in agent context, not in error logs.",
  },
  {
    icon: Terminal,
    title: "Drop-in for your runtime",
    description:
      "agentpass run claude wires OPENAI_BASE_URL and ANTHROPIC_BASE_URL automatically. Works with Claude Code, Cursor, OpenClaw, Codex.",
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
        <p className="mx-auto mt-3 max-w-xl text-center text-sm text-muted">
          Your agent points <code className="font-mono text-fg">OPENAI_BASE_URL</code> at the local proxy. AgentPass picks a live key, attaches the auth header, and forwards the request — falling over silently if the chosen key is throttled or rotated.
        </p>

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
            <span className="text-xs text-accent">localhost:8888</span>
          </div>

          <div className="flex flex-col items-center gap-2 text-center">
            <div className="relative flex h-16 w-16 items-center justify-center rounded-xl border border-accent/30 bg-accent/5">
              <Lock className="h-6 w-6 text-accent" />
            </div>
            <span className="text-sm font-medium text-fg">AgentPass</span>
            <span className="text-xs text-muted">Vault + Pool + Failover</span>
          </div>

          <div className="flex flex-col items-center gap-1">
            <ArrowRight className="hidden h-5 w-5 text-muted sm:block" />
            <span className="text-xs text-muted sm:hidden">↓</span>
            <span className="text-xs text-accent">live key only</span>
          </div>

          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-card">
              <Globe className="h-6 w-6 text-muted" />
            </div>
            <span className="text-sm font-medium text-fg">Provider API</span>
            <span className="text-xs text-muted">OpenAI / Anthropic</span>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
