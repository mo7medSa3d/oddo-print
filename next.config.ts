import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const deploymentId = process.env.YASEIR_DEPLOYMENT_ID?.trim();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  compress: true,
  // Next compares deployment IDs during navigation and refreshes stale
  // prefetches instead of calling action IDs from an incompatible build.
  // Never put an encryption key or secret into this public release identifier.
  ...(deploymentId ? { deploymentId } : {}),
  experimental: {
    serverActions: {
      bodySizeLimit: "8mb",
    },
  },
  async headers() {
    const headers = [...securityHeaders];
    if (process.env.NODE_ENV === "production") {
      headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
    }
    return [
      {
        source: "/videos/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      { source: "/(.*)", headers },
    ];
  },
  async redirects() {
    return [
      // The control-plane entry point has no page of its own; land visitors
      // on the platform sign-in, which forwards authenticated sessions to
      // the dashboard after it resolves the platform session.
      { source: "/platform", destination: "/platform/login", permanent: false },
    ];
  },
};

export default nextConfig;
