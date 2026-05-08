"use client";

import { motion } from "framer-motion";
import { Terminal, Lock, Shield } from "lucide-react";

export default function Hero() {
  return (
    <section className="relative overflow-hidden pt-16 pb-20 sm:pt-24 sm:pb-28">
      <div className="absolute inset-0 glow-bg pointer-events-none" />

      <div className="relative mx-auto max-w-4xl px-4 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/5 px-3 py-1 text-xs font-medium text-accent mb-8"
        >
          <Shield className="h-3 w-3" />
          Open source. Local-first. CLI-native.
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-4xl font-bold tracking-tight text-fg sm:text-6xl"
        >
          Your AI agents will{" "}
          <span className="text-accent">never see</span> your API keys again
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mx-auto mt-6 max-w-2xl text-lg text-muted"
        >
          AgentPass is a local-first credential broker that encrypts your secrets
          and injects them via HTTP proxy — so Claude Code, Cursor, and any
          agent runtime stay blind to your keys.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center"
        >
          <a
            href="#waitlist"
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-bg transition-opacity hover:opacity-90"
          >
            <Lock className="h-4 w-4" />
            Join the waitlist
          </a>
          <a
            href="https://github.com/Rakesh1002/agentpass"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-6 py-3 text-sm font-semibold text-fg transition-colors hover:bg-card-hover"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
            </svg>
            Star on GitHub
          </a>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="mx-auto mt-16 max-w-2xl"
        >
          <div className="overflow-hidden rounded-xl border border-border bg-[#0d0d0f] shadow-2xl shadow-accent/5">
            <div className="flex items-center gap-1.5 border-b border-border px-4 py-3">
              <div className="h-3 w-3 rounded-full bg-red-500/80" />
              <div className="h-3 w-3 rounded-full bg-yellow-500/80" />
              <div className="h-3 w-3 rounded-full bg-green-500/80" />
              <span className="ml-2 text-xs text-muted font-mono">agentpass</span>
            </div>
            <div className="p-4 font-mono text-sm text-muted">
              <div className="flex gap-2">
                <span className="text-accent">$</span>
                <span className="text-fg">agentpass init --password mymasterpass</span>
              </div>
              <div className="mt-1 text-accent">✅ Vault initialized successfully</div>

              <div className="mt-3 flex gap-2">
                <span className="text-accent">$</span>
                <span className="text-fg">agentpass add openai sk-xxx</span>
              </div>
              <div className="mt-1 text-accent">✅ Added secret: openai</div>

              <div className="mt-3 flex gap-2">
                <span className="text-accent">$</span>
                <span className="text-fg">agentpass run claude</span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-muted">
                <Terminal className="h-3 w-3" />
                <span>Proxy running on :8888 — Claude Code is now secure</span>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
