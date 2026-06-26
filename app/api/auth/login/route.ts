// POST /api/auth/login  { client, password }
// Validates the client name + password against that account's configured password
// and, on success, sets an httpOnly signed session cookie locked to the account.
//
// SEAM: magic-link / SSO login is a later phase. When it lands, this route is
// replaced by the callback that mints the same `v2:<slug>` session cookie.
import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, checkLogin, makeSessionCookieValue } from "@/lib/auth";
import { rateLimit, rateLimitReset } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Per-IP login throttle (a brute-force speed bump; in-process / best-effort).
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function clientIp(req: NextRequest): string {
  // Vercel populates req.ip with the platform-trusted client IP — prefer it.
  // x-real-ip / x-forwarded-for are client-settable, so an attacker could rotate
  // them to dodge a per-IP limit. Only use the LAST x-forwarded-for hop (the one a
  // trusted proxy appended) as a best-effort fallback for non-Vercel hosts.
  if (req.ip) return req.ip;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1]!;
  }
  return "local";
}

// IPs that bypass the login throttle entirely. Set LOGIN_RATE_LIMIT_ALLOWLIST to a
// comma-separated list (e.g. your own office/home IP) so the brute-force speed bump
// never locks you out. Matched exactly against the IP the platform reports for the
// request (see the `[login] rate-limited ip=` log line). Empty/unset -> nobody is exempt.
function isRateLimitExempt(ip: string): boolean {
  const raw = process.env.LOGIN_RATE_LIMIT_ALLOWLIST;
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(ip);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Reject oversized bodies up front — login carries only { client, password }.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 20_000) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }

  // Throttle by client IP BEFORE any credential work — unless this IP is allowlisted
  // (e.g. your own office/home IP) so the brute-force speed bump never locks you out.
  const ip = clientIp(req);
  const exempt = isRateLimitExempt(ip);
  const rlKey = `login:${ip}`;
  if (!exempt) {
    const rl = rateLimit(rlKey, LOGIN_LIMIT, LOGIN_WINDOW_MS);
    if (!rl.ok) {
      // Log the throttled IP so you can read it from Vercel's logs and add it to
      // LOGIN_RATE_LIMIT_ALLOWLIST if it's yours.
      // eslint-disable-next-line no-console
      console.warn(`[login] rate-limited ip=${ip}`);
      return NextResponse.json(
        { error: "Too many sign-in attempts. Please wait and try again." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }
  }

  let client = "";
  let password = "";
  try {
    const body = (await req.json()) as { client?: unknown; password?: unknown };
    if (typeof body.client === "string") client = body.client;
    if (typeof body.password === "string") password = body.password;
  } catch {
    // fall through to invalid-credentials response
  }

  const slug = client && password ? checkLogin(client, password) : null;
  if (!slug) {
    return NextResponse.json(
      { error: "Incorrect client name or password" },
      { status: 401 },
    );
  }

  // A legit login clears this IP's throttle so an honest fat-finger never locks out.
  if (!exempt) rateLimitReset(rlKey);

  const res = NextResponse.json({ ok: true, slug });
  res.cookies.set({
    name: AUTH_COOKIE,
    value: makeSessionCookieValue(slug),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12, // 12h
  });
  return res;
}
