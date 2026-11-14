import type { NextConfig } from "next";

// A full script-src CSP would need nonces for Next's inline scripts; these directives are safe without them.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=15552000" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async redirects() {
    // OpenNext leaves an empty :path* unsubstituted, so the bare root gets its own rule.
    const hosts = ["www.agentpass.sh", "pass.agentdrive.sh"].flatMap((host) => {
      const has = [{ type: "host" as const, value: host }];
      return [
        { source: "/", has, destination: "https://agentpass.sh/", permanent: true },
        { source: "/:path+", has, destination: "https://agentpass.sh/:path+", permanent: true },
      ];
    });
    // OpenNext can't rewrite to a static asset; curl -L follows this instead.
    return [...hosts, { source: "/install", destination: "/install.sh", permanent: false }];
  },
};

export default nextConfig;
