"use client";

import { motion } from "framer-motion";
import { KeyRound, ShieldCheck, GitBranch, Server, Search, Lock, Terminal, ArrowRight, Globe } from "lucide-react";

const features = [
  {
    icon: KeyRound,
    title: "Placeholders, not keys",
    description:
      "Agents get STRIPE_SECRET_KEY={{secret:stripe}}. The real value never enters their environment, transcripts or commits.",
  },
  {
    icon: ShieldCheck,
    title: "Pinned to the hosts you choose",
    description:
      "Each key is pinned to hosts, ports, methods and paths. Anywhere else, the request is refused with egress_blocked and written to the audit log.",
  },
  {
    icon: GitBranch,
    title: "One manifest for every worktree",
    description:
      ".agentpass.json maps env vars to vault names and is safe to commit. Every worktree gets the same keys; a manifest from a cloned repo waits for agentpass allow.",
  },
  {
    icon: Server,
    title: "Background proxy",
    description:
      "agentpass up runs the proxy now and at login, unlocking the vault from your OS keychain. No password prompts, no key in your shell.",
  },
  {
    icon: Search,
    title: "Find exposed keys",
    description:
      "agentpass scan finds plaintext keys in .env files, shell rc files and agent configs that your agents can already read.",
  },
  {
    icon: Lock,
    title: "Local and open source",
    description:
      "The encrypted vault and audit log live in ~/.agentpass on your machine. MIT licensed. Every request is tagged with its repo, branch and agent.",
  },
];

export default function Features() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
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
          Your agent runs with <code className="font-mono text-fg">HTTPS_PROXY</code> pointed at the local proxy and holds only placeholders. For a host the key is pinned to, AgentPass swaps in the real value and forwards the request over HTTPS. Keep several keys for one provider and a 429 or 401 fails over to the next.
        </p>

        <div className="mx-auto mt-10 flex max-w-3xl flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-card">
              <Terminal className="h-6 w-6 text-accent" />
            </div>
            <span className="text-sm font-medium text-fg">AI Agent</span>
            <span className="text-xs text-muted">Claude Code / Codex CLI</span>
          </div>

          <div className="flex flex-col items-center gap-1">
            <ArrowRight className="hidden h-5 w-5 text-muted sm:block" />
            <span className="text-xs text-muted sm:hidden">↓</span>
            <span className="text-xs text-accent">placeholders only</span>
          </div>

          <div className="flex flex-col items-center gap-2 text-center">
            <div className="relative flex h-16 w-16 items-center justify-center rounded-xl border border-accent/30 bg-accent/5">
              <Lock className="h-6 w-6 text-accent" />
            </div>
            <span className="text-sm font-medium text-fg">AgentPass</span>
            <span className="text-xs text-muted">Vault + Pins + Audit</span>
          </div>

          <div className="flex flex-col items-center gap-1">
            <ArrowRight className="hidden h-5 w-5 text-muted sm:block" />
            <span className="text-xs text-muted sm:hidden">↓</span>
            <span className="text-xs text-accent">pinned hosts only</span>
          </div>

          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-card">
              <Globe className="h-6 w-6 text-muted" />
            </div>
            <span className="text-sm font-medium text-fg">Your APIs</span>
            <span className="text-xs text-muted">Stripe / OpenAI / GitHub</span>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
