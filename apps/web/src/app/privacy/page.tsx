import type { Metadata } from "next";
import Link from "next/link";
import Footer from "@/components/Footer";

export const metadata: Metadata = {
  title: "Privacy — AgentPass",
  description: "What agentpass.sh collects when you sign up for release notes, and how to have it deleted.",
  alternates: { canonical: "/privacy" },
};

const UPDATED = "14 November 2026";

export default function PrivacyPage() {
  return (
    <main>
      <article className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
        <Link href="/" className="text-sm text-muted hover:text-fg">
          ← agentpass.sh
        </Link>
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-fg">Privacy</h1>
        <p className="mt-2 text-sm text-muted">Last updated {UPDATED}</p>

        <div className="mt-10 space-y-8 text-[15px] leading-7 text-fg/90">
          <section>
            <h2 className="text-lg font-semibold text-fg">The AgentPass CLI</h2>
            <p className="mt-2">
              The CLI and its proxy run on your machine. Your secrets, your vault and your audit log stay there.
              The CLI does not send us anything.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">This website</h2>
            <p className="mt-2">
              The site sets no cookies and runs no analytics. When you sign up for release notes we store:
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-6">
              <li>your email address and the time you signed up;</li>
              <li>
                a salted SHA-256 hash of your IP address, used to rate-limit signups and stop abuse (we cannot
                recover your IP from it);
              </li>
              <li>the page that referred you, if your browser sends one.</li>
            </ul>
            <p className="mt-3">
              We use your email only to send short notes when a new release ships. We do not sell it or share it
              with anyone else. The site and its database are hosted on Cloudflare, which processes this data on
              our behalf.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">Keeping and deleting it</h2>
            <p className="mt-2">
              We keep your signup until you ask us to delete it, or until we stop sending release notes. To have it
              deleted, or to ask what we hold about you, email{" "}
              <a href="mailto:privacy@agentpass.sh" className="text-accent underline">
                privacy@agentpass.sh
              </a>{" "}
              from the address you signed up with. We act on requests within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg">Changes</h2>
            <p className="mt-2">
              If this policy changes, we update this page and the date above.
            </p>
          </section>
        </div>
      </article>
      <Footer />
    </main>
  );
}
