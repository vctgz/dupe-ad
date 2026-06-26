// Auth middleware: redirect unauthenticated page navigations to /login.
//
// Runs on the Edge runtime, which has Web Crypto but not Node's crypto. We do a
// LIGHT presence/shape check of the signed cookie here (cheap, no secret access);
// the cryptographic signature is verified in the API route handlers / server
// components via lib/auth (Node runtime, where the secret lives). This keeps the
// passcode out of the Edge bundle while still gating navigation.
//
// SEAM: a later magic-link phase swaps the cookie scheme; this matcher and the
// /login redirect stay the same.
import { NextRequest, NextResponse } from "next/server";

const AUTH_COOKIE = "ads_tool_session";
// Must match SESSION_VERSION in lib/auth.ts. Payload is `v3:<slug>:<exp>:<nonce>.<hexsig>`.
const SESSION_PREFIX = "v3:";

function looksLikeSession(value: string | undefined): boolean {
  if (!value) return false;
  // v2:<slug>.<hexsig> — full HMAC verification happens server-side in lib/auth.
  if (!value.startsWith(SESSION_PREFIX)) return false;
  const dot = value.lastIndexOf(".");
  return dot > SESSION_PREFIX.length;
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // The login portal is optional. When AUTH_ENABLED is not "true", run open.
  if (process.env.AUTH_ENABLED !== "true") {
    return NextResponse.next();
  }

  // Public paths.
  if (
    pathname === "/login" ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/icon.svg"
  ) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  if (looksLikeSession(cookie)) {
    return NextResponse.next();
  }

  // API routes: 401 JSON (they also re-verify via lib/route-guard).
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Page navigations: redirect to /login, remembering where they were headed so
  // the form can return them there. Only the path+query is carried (a relative,
  // same-origin value); LoginForm re-validates it via safeInternalPath() before
  // using it, so this can't become an open redirect.
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const dest = pathname + req.nextUrl.search;
  if (dest && dest !== "/") {
    url.searchParams.set("next", dest);
  }
  return NextResponse.redirect(url);
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
