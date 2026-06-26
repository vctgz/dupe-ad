/** @type {import('next').NextConfig} */
// Security response headers applied to every route. The CSP locks every resource
// to same-origin (default-src 'self') plus the data:/blob: URIs the app genuinely
// uses (inline SVG icons, in-browser image previews). script-src/style-src keep
// 'unsafe-inline' because Next injects inline bootstrap scripts and styles without
// nonces; a nonce-based strict CSP is a future hardening, but this still blocks
// loading scripts/objects/frames from any other origin.
//
// 'unsafe-eval' is only needed by Next's dev runtime (React Refresh / HMR). Drop it in
// production builds so an XSS can't reach eval()/new Function().
const isProd = process.env.NODE_ENV === "production";
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "Content-Security-Policy", value: csp },
];

const nextConfig = {
  reactStrictMode: true,
  // Don't advertise the framework/version to attackers.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
