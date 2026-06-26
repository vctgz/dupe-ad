// Server-only, zod-validated environment loader. Fails fast with a clear message
// listing every missing/invalid var so a misconfigured deploy never silently does
// the wrong thing.
//
// Phase 0 runs in SNAPSHOT mode with ONLY `APP_ACCESS_PASSCODE` set — the app boots
// and renders the on-disk discovery snapshots without any Meta Graph credentials.
// The Meta App credentials are OPTIONAL here; they're required ONLY when a request
// actually needs the LIVE source (see `requireLiveEnv`).
//
// IMPORTANT: never import this from a client component. It reads secrets
// (META_APP_SECRET, tokens, the passcode) that must never reach the browser.
import "server-only";
import { z } from "zod";

const envSchema = z.object({
  // Pinned Graph API version. Don't float it — Meta changes field shapes.
  META_GRAPH_VERSION: z
    .string()
    .min(1, "required")
    .regex(/^v\d+\.\d+$/, 'must look like "v23.0"')
    .default("v23.0"),

  // Meta App credentials (App Dashboard -> Settings -> Basic). OPTIONAL at boot —
  // required only for the LIVE source (validated via requireLiveEnv()).
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),

  // Business Manager System User token (server-side only). OPTIONAL at boot.
  META_SYSTEM_USER_TOKEN: z.string().optional(),

  // Optional per-account token overrides (example name; the real var names come
  // from ACCOUNTS_JSON `tokenEnvVar` and are read dynamically via process.env).
  // Empty/unset -> fall back to the system token.
  META_TOKEN_ACME: z.string().optional(),

  // DEPRECATED single passcode (superseded by per-client logins). Optional — kept
  // so older .env files don't fail at boot. No longer used by the auth flow.
  APP_ACCESS_PASSCODE: z.string().optional(),

  // Per-account login passwords (example name; the real var names come from
  // config/accounts.ts `passwordEnvVar` and are read dynamically). An account signs
  // in with its name + this password. Optional at boot; an account with no
  // configured password simply can't log in.
  APP_PASSWORD_ACME: z.string().optional(),

  // Secret used to sign the session cookie (HMAC). Optional: when unset, the
  // signer derives a key from the configured client passwords so sessions stay
  // unforgeable without a separately-managed secret.
  APP_SESSION_SECRET: z.string().optional(),

  // Optional per-account login portal. "true" requires login and locks each
  // signed-in user to one ad account; anything else leaves the app open.
  AUTH_ENABLED: z.string().optional(),

  // Escape hatch for the fail-closed live guard: set "true" to allow running with live
  // Meta credentials while AUTH_ENABLED is off in production (only if gated another way,
  // e.g. Cloudflare Access). Otherwise that combination refuses to boot. See getEnv().
  ALLOW_UNAUTHENTICATED_LIVE: z.string().optional(),

  // Which data source to use: "auto" (default) picks live when usable creds exist for
  // the account, else snapshot, else the mapping store-list; "snapshot"/"live"/"mapping"
  // force the source (mirrors the per-request ?source= values the discovery route accepts).
  DISCOVERY_SOURCE: z.enum(["auto", "snapshot", "live", "mapping"]).default("auto"),

  // Ad name used to identify the "Template" ad per campaign (case-insensitive exact match).
  TEMPLATE_AD_NAME: z.string().min(1).default("Template"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/**
 * Validate and return the environment. Throws a single, readable error listing
 * every problem if anything is missing/invalid. With only APP_ACCESS_PASSCODE set,
 * this succeeds (snapshot mode).
 */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid or missing environment variables:\n${issues}\n\n` +
        "Copy .env.example to .env.local and fill in the values.",
    );
  }

  cached = parsed.data;

  // When the login portal is on in production, require a dedicated signing secret
  // of real length (the password-derived fallback in lib/auth is not acceptable
  // there, and a short secret is brute-forceable). 32+ chars; `openssl rand -hex 32`.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.AUTH_ENABLED === "true" &&
    (!nonEmpty(cached.APP_SESSION_SECRET) || cached.APP_SESSION_SECRET.trim().length < 32)
  ) {
    throw new Error(
      "APP_SESSION_SECRET must be set to a strong value (32+ chars, e.g. `openssl rand -hex 32`) " +
        "when AUTH_ENABLED=true in production (the password-derived session-key fallback is disabled there).",
    );
  }

  // Fail closed: never run live-write-capable AND unauthenticated in production. A deploy
  // with Meta credentials but AUTH_ENABLED off would expose live ad discovery + creation to
  // anyone who can reach it. Require the login, or an explicit opt-in for a deployment that
  // is gated another way (e.g. Cloudflare Access, an IP allowlist).
  if (
    process.env.NODE_ENV === "production" &&
    process.env.AUTH_ENABLED !== "true" &&
    process.env.ALLOW_UNAUTHENTICATED_LIVE !== "true" &&
    nonEmpty(cached.META_APP_ID) &&
    nonEmpty(cached.META_APP_SECRET) &&
    hasAnyLiveToken(cached.META_SYSTEM_USER_TOKEN)
  ) {
    throw new Error(
      "Refusing to start: Meta live credentials are configured but the login is off " +
        '(AUTH_ENABLED is not "true"), so live ad discovery and creation would be open to ' +
        "anyone who can reach this deployment. Set AUTH_ENABLED=true, or — only if this app " +
        'is gated another way (e.g. Cloudflare Access) — set ALLOW_UNAUTHENTICATED_LIVE=true.',
    );
  }

  return cached;
}

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * True when ANY usable Meta access token is configured: the shared system token, or a
 * per-account META_TOKEN_<SLUG> override. Used by the fail-closed live guard in getEnv().
 */
function hasAnyLiveToken(systemToken: string | undefined): boolean {
  if (nonEmpty(systemToken)) return true;
  return Object.entries(process.env).some(
    ([k, v]) => k.startsWith("META_TOKEN_") && nonEmpty(v),
  );
}

/**
 * True when an account COULD be served live: the shared Meta App credentials exist
 * AND a usable access token is configured (the account's override, else the system
 * token). Used by the "auto" source resolver — never throws.
 */
export function hasLiveCredentials(tokenEnvVar?: string): boolean {
  const env = getEnv();
  if (!nonEmpty(env.META_APP_ID) || !nonEmpty(env.META_APP_SECRET)) return false;
  const override = tokenEnvVar ? process.env[tokenEnvVar] : undefined;
  return nonEmpty(override) || nonEmpty(env.META_SYSTEM_USER_TOKEN);
}

/** The credentials the LIVE source needs, asserted present. */
export interface LiveEnv {
  META_APP_ID: string;
  META_APP_SECRET: string;
}

/**
 * Assert the Meta App credentials needed for the LIVE source are present, returning
 * them narrowed to non-optional. Throws a clean error (callers map to HTTP 400) when
 * a live request comes in without creds — the app never crashes at boot for this.
 */
export function requireLiveEnv(tokenEnvVar?: string): LiveEnv {
  const env = getEnv();
  const missing: string[] = [];
  if (!nonEmpty(env.META_APP_ID)) missing.push("META_APP_ID");
  if (!nonEmpty(env.META_APP_SECRET)) missing.push("META_APP_SECRET");
  const override = tokenEnvVar ? process.env[tokenEnvVar] : undefined;
  if (!nonEmpty(override) && !nonEmpty(env.META_SYSTEM_USER_TOKEN)) {
    missing.push(tokenEnvVar ? `${tokenEnvVar} or META_SYSTEM_USER_TOKEN` : "META_SYSTEM_USER_TOKEN");
  }
  if (missing.length > 0) {
    throw new LiveCredentialsError(
      `Live source needs Meta credentials: missing ${missing.join(", ")}.`,
    );
  }
  return { META_APP_ID: env.META_APP_ID!, META_APP_SECRET: env.META_APP_SECRET! };
}

/** Thrown when a live request lacks Meta credentials — handlers map this to HTTP 400. */
export class LiveCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveCredentialsError";
  }
}
