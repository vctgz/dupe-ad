// Phase 0 auth: per-CLIENT login (account name + password).
//
// Each account (e.g. Acme, Demo) signs in with its account name and a
// password held in that account's `passwordEnvVar`. On success we set an httpOnly,
// signed cookie whose payload IS the authenticated account slug (`v2:<slug>`), so
// the session is locked to exactly one ad account — there is no in-app account
// switching. The signature is an HMAC keyed by APP_SESSION_SECRET (or a key
// derived from the client passwords), so the cookie can't be forged and can't be
// read/modified by client JS.
//
// SEAM: magic-link / SSO is a later phase. When it lands, this module stays the
// session verifier — mint the same `v2:<slug>` cookie from the new flow and every
// guard (middleware, route-guard) keeps working unchanged.
import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";
import { AD_ACCOUNTS, getAccountBySlug } from "@/config/accounts";

export const AUTH_COOKIE = "ads_tool_session";

// Bump if the cookie scheme changes so old cookies are rejected after a deploy.
// v3 adds an expiry + random nonce to the signed payload (v2 had neither), so a
// captured cookie stops verifying after SESSION_TTL_SECONDS — not just when the
// browser drops it.
const SESSION_VERSION = "v3";
// Server-side session lifetime baked into the signed payload. Keep aligned with
// the cookie Max-Age set in app/api/auth/login/route.ts.
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

/**
 * Whether the optional per-account login portal is enabled. OFF by default so the
 * tool runs open for simple self-hosting. Set AUTH_ENABLED=true to require login
 * and lock each signed-in user to one ad account (for example, give a teammate an
 * account's password and they only ever see that account).
 */
export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === "true";
}

/** HMAC key: APP_SESSION_SECRET if set, else derived from the client passwords. */
function signingSecret(): string {
  const { APP_SESSION_SECRET } = getEnv();
  if (APP_SESSION_SECRET && APP_SESSION_SECRET.trim().length > 0) {
    return APP_SESSION_SECRET;
  }
  // Fallback so the app is unforgeable without a separately-managed secret.
  // Changing a client password invalidates existing sessions (acceptable).
  const joined = AD_ACCOUNTS.map((a) => (a.passwordEnvVar ? process.env[a.passwordEnvVar] : "") ?? "").join("|");
  return `derived-session-key:${joined}`;
}

function sign(payload: string): string {
  return createHmac("sha256", signingSecret()).update(payload).digest("hex");
}

/** Constant-time string compare (returns false on length mismatch). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The configured password for an account slug (from its passwordEnvVar), or "". */
function passwordFor(slug: string): string {
  const acct = getAccountBySlug(slug);
  if (!acct || !acct.passwordEnvVar) return "";
  return process.env[acct.passwordEnvVar] ?? "";
}

/**
 * Resolve a typed username to an account slug by EXACT match against the slug
 * (e.g. "acme" or "acme-west"). Case-insensitive on input, but the looser label,
 * spacing, and squished variants are intentionally NOT accepted, so the username
 * is unambiguous. Returns null when nothing matches exactly.
 */
export function normalizeClientToSlug(input: string): string | null {
  const candidate = input.trim().toLowerCase();
  if (!candidate) return null;
  const acct = AD_ACCOUNTS.find((a) => a.slug.toLowerCase() === candidate);
  return acct ? acct.slug : null;
}

/**
 * Validate a client + password login. Returns the authenticated account slug on
 * success, or null. Constant-time password compare; unknown clients and clients
 * with no configured password both return null.
 */
export function checkLogin(client: string, password: string): string | null {
  const slug = normalizeClientToSlug(client);
  if (!slug) return null;
  const expected = passwordFor(slug);
  if (!expected) return null;
  if (!constantTimeEqual(password, expected)) return null;
  return slug;
}

/** The signed cookie value for an authenticated account slug. */
export function makeSessionCookieValue(slug: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = randomBytes(16).toString("hex");
  const payload = `${SESSION_VERSION}:${slug}:${exp}:${nonce}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify a cookie value and return the authenticated account slug, or null.
 * Checks the version prefix, that the slug is a real account, and the HMAC.
 */
export function accountSlugFromCookieValue(value: string | undefined | null): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const prefix = `${SESSION_VERSION}:`;
  if (!payload.startsWith(prefix)) return null;
  // payload = v3:<slug>:<exp-epoch-seconds>:<nonce>  (parse from the end so a slug
  // with an unexpected ':' can't shift the fields).
  const parts = payload.slice(prefix.length).split(":");
  if (parts.length < 3) return null;
  const nonce = parts.pop();
  const expStr = parts.pop();
  const slug = parts.join(":");
  if (!slug || !nonce || !getAccountBySlug(slug)) return null;
  // Integrity first (constant-time HMAC over the exact payload), then freshness.
  if (!constantTimeEqual(sig, sign(payload))) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Math.floor(Date.now() / 1000) > exp) return null;
  return slug;
}

/** Back-compat boolean check (guards that only need "is there a valid session"). */
export function isAuthedFromCookieValue(value: string | undefined | null): boolean {
  return accountSlugFromCookieValue(value) !== null;
}