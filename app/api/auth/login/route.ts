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

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Throttle by client IP BEFORE doing any credential work.
  const rlKey = `login:${clientIp(req)}`;
  const rl = rateLimit(rlKey, LOGIN_LIMIT, LOGIN_WINDOW_MS);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
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
  rateLimitReset(rlKey);

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
