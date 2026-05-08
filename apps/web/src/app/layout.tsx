import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentPass — Credential broker for AI agents",
  description:
    "Your AI agents will never see your API keys again. Local-first credential broker for Claude Code, Cursor, OpenClaw.",
  openGraph: {
    title: "AgentPass — Credential broker for AI agents",
    description:
      "Your AI agents will never see your API keys again. Local-first credential broker for Claude Code, Cursor, OpenClaw.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "AgentPass — Credential broker for AI agents",
    description:
      "Your AI agents will never see your API keys again. Local-first credential broker for Claude Code, Cursor, OpenClaw.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          rel="preconnect"
          href="https://cdn.jsdelivr.net"
          crossOrigin="anonymous"
        />
        <link
          href="https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-sans/style.css"
          rel="stylesheet"
        />
        <link
          href="https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts/geist-mono/style.css"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen antialiased">
        {children}
      </body>
    </html>
  );
}
