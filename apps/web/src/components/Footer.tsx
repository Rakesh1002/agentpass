export default function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-2 text-sm text-muted">
            <span className="font-semibold text-fg">AgentPass</span>
            <span>— Local-first. Open source. Built for AI agents.</span>
          </div>

          <div className="flex items-center gap-6 text-sm text-muted">
            <a
              href="https://github.com/Rakesh1002/agentpass"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-fg"
            >
              GitHub
            </a>
            <a
              href="https://x.com/Rakesh1002"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-fg"
            >
              X
            </a>
            <a
              href="https://pass.agentdrive.sh"
              className="transition-colors hover:text-fg"
            >
              Docs
            </a>
          </div>
        </div>

        <div className="mt-8 text-center text-xs text-muted/60">
          Built with Bun + Next.js + OpenNext. Deployed on Cloudflare Workers.
        </div>
      </div>
    </footer>
  );
}
