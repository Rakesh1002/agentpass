"use client";

import { motion } from "framer-motion";

const agents = [
  { name: "Claude Code", description: "HTTPS_PROXY, ANTHROPIC_BASE_URL", color: "#D97757" },
  { name: "Codex CLI", description: "HTTPS_PROXY, OPENAI_BASE_URL", color: "#10B981" },
];

export default function Agents() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="text-center"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Works with
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-sm text-muted">
          Agents that honour{" "}
          <code className="font-mono text-fg">HTTPS_PROXY</code> /{" "}
          <code className="font-mono text-fg">*_BASE_URL</code>, such as Claude
          Code and Codex CLI. No plugin or official integration needed.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-6 sm:gap-10">
          {agents.map((agent) => (
            <div
              key={agent.name}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-5 py-3 transition-colors hover:bg-card-hover"
            >
              <div
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: agent.color }}
              />
              <div className="text-left">
                <div className="text-sm font-semibold text-fg">
                  {agent.name}
                </div>
                <div className="font-mono text-xs text-muted">{agent.description}</div>
              </div>
            </div>
          ))}
        </div>
      </motion.div>
    </section>
  );
}
