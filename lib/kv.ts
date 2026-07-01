// Minimal Upstash-Redis-over-REST client — SERVER ONLY, zero dependencies.
//
// Why: the in-process caches (live discovery, tracking pixel) evaporate on every
// serverless cold start and are invisible across concurrent instances, so each new
// instance re-pulls the whole account from Meta and burns rate-limit quota. Backing
// them with the Redis store Vercel provisions ("Upstash for Redis" marketplace
// integration; the classic Vercel KV env names also work) makes the caches shared.
//
// OPTIONAL by design: with no KV env vars every helper is a silent no-op returning
// null, and callers keep their in-process fallbacks — local dev needs nothing new.
// All operations are best-effort: a KV failure must never fail the request.
import "server-only";

function kvEnv(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || url.trim().length === 0 || !token || token.trim().length === 0) return null;
  return { url: url.replace(/\/$/, ""), token };
}

/** True when a shared KV store is configured. */
export function kvAvailable(): boolean {
  return kvEnv() !== null;
}

/** GET a JSON value. Returns null on miss, missing config, or any error. */
export async function kvGet<T>(key: string): Promise<T | null> {
  const env = kvEnv();
  if (!env) return null;
  try {
    const res = await fetch(`${env.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: string | null };
    if (body.result == null) return null;
    return JSON.parse(body.result) as T;
  } catch {
    return null;
  }
}

/** SET a JSON value with a TTL (seconds). Best-effort; errors are swallowed. */
export async function kvSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  const env = kvEnv();
  if (!env) return;
  try {
    // Value goes in the request body (Upstash's large-value form) so size/encoding
    // never break the URL.
    await fetch(`${env.url}/set/${encodeURIComponent(key)}?EX=${Math.max(1, Math.floor(ttlSec))}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.token}` },
      body: JSON.stringify(value),
      cache: "no-store",
    });
  } catch {
    // best-effort
  }
}
