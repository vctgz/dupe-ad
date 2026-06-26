// In-memory, best-effort rate limiter for the login route.
//
// Keyed per client IP, fixed window. Enough to blunt password brute-force on a
// low-traffic, gated self-host (closes the pen-test gap). It is PER-PROCESS, so on
// a multi-instance serverless deploy each instance keeps its own window — fine as a
// speed bump, but for a strict global limit back this with a shared store (Vercel
// KV / Upstash Redis). It is never the only defense: keep strong APP_PASSWORD_* values.
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
// Soft cap so the map can't grow unbounded across many distinct IPs over time.
const MAX_KEYS = 5000;

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets, when ok is false. */
  retryAfterSec: number;
}

/**
 * Count one hit against `key`. Returns ok=false once more than `limit` hits land
 * inside the rolling `windowMs`. Fixed window: the count resets when the window
 * elapses, and a successful login should call rateLimitReset() so legit users who
 * fat-finger a password are never locked out.
 */
export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) {
    for (const [k, b] of buckets) if (now >= b.resetAt) buckets.delete(k);
  }
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > limit) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfterSec: 0 };
}

/** Clear a key's window (call on a successful login so legit users never lock out). */
export function rateLimitReset(key: string): void {
  buckets.delete(key);
}
