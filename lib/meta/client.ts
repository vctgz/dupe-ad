// Meta Graph API client — SERVER ONLY.
//
// Implements the load-bearing facts from docs/01-meta-api-facts.md:
//   - appsecret_proof = HMAC-SHA256(accessToken, META_APP_SECRET) (hex) on EVERY call (#9).
//   - access_token sent server-side only; the browser never sees it.
//   - cursor pagination via paging.cursors.after, concatenating all pages (#2/§2.2).
//   - reads + logs the X-Business-Use-Case-Usage header for rate-limit pacing (#8).
//   - throws a typed MetaApiError parsed from Meta's error body.
import "server-only";
import { createHmac } from "node:crypto";
import { getEnv, requireLiveEnv } from "@/lib/env";
import type { AdAccount } from "@/config/accounts";

/** Typed Meta API error, parsed from Meta's `{ error: { ... } }` response body. */
export class MetaApiError extends Error {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;
  readonly httpStatus: number;
  readonly fbtraceId: string | null;

  constructor(args: {
    message: string;
    code: number | null;
    subcode: number | null;
    type: string | null;
    httpStatus: number;
    fbtraceId?: string | null;
  }) {
    super(args.message);
    this.name = "MetaApiError";
    this.code = args.code;
    this.subcode = args.subcode;
    this.type = args.type;
    this.httpStatus = args.httpStatus;
    this.fbtraceId = args.fbtraceId ?? null;
  }
}

/**
 * Resolve the access token for an account: prefer the account's `tokenEnvVar`
 * when it is set AND non-empty; otherwise fall back to META_SYSTEM_USER_TOKEN.
 *
 * Throws LiveCredentialsError (mapped to HTTP 400) if no usable token / app creds
 * are configured — the LIVE path is the only caller, so the app still boots in
 * snapshot mode with no Meta credentials.
 */
export function resolveToken(account: AdAccount): string {
  requireLiveEnv(account.tokenEnvVar);
  const env = getEnv();
  if (account.tokenEnvVar) {
    const override = process.env[account.tokenEnvVar];
    if (override && override.trim().length > 0) return override;
  }
  return env.META_SYSTEM_USER_TOKEN!;
}

/** appsecret_proof = HMAC-SHA256(accessToken, app_secret), hex. */
function appSecretProof(accessToken: string): string {
  const { META_APP_SECRET } = requireLiveEnv();
  return createHmac("sha256", META_APP_SECRET).update(accessToken).digest("hex");
}

function baseUrl(): string {
  const { META_GRAPH_VERSION } = getEnv();
  return `https://graph.facebook.com/${META_GRAPH_VERSION}`;
}

type ParamValue = string | number | boolean;

interface MetaPagingResponse<T> {
  data?: T[];
  paging?: {
    cursors?: { before?: string; after?: string };
    next?: string;
  };
}

/**
 * Parse the X-Business-Use-Case-Usage header and log a compact summary. The header
 * is JSON keyed by ad-account id; each entry carries call_count, total_cputime,
 * total_time, estimated_time_to_regain_access. We log the worst-case so a future
 * queue can pace near 80% (the throttle guard lives in the write phase, later).
 */
function logBusinessUseCaseUsage(headers: Headers, path: string): void {
  const raw = headers.get("x-business-use-case-usage");
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      Array<{
        call_count?: number;
        total_cputime?: number;
        total_time?: number;
        estimated_time_to_regain_access?: number;
      }>
    >;
    let worst = 0;
    let regain = 0;
    for (const entries of Object.values(parsed)) {
      for (const e of entries) {
        worst = Math.max(worst, e.call_count ?? 0, e.total_cputime ?? 0, e.total_time ?? 0);
        regain = Math.max(regain, e.estimated_time_to_regain_access ?? 0);
      }
    }
    // eslint-disable-next-line no-console
    console.info(
      `[meta] BUC usage on ${path}: worst=${worst}% regain=${regain}min`,
    );
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[meta] could not parse x-business-use-case-usage on ${path}`);
  }
}

async function throwMetaError(res: Response, path: string): Promise<never> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON error body
  }
  const err =
    body && typeof body === "object" && "error" in body
      ? (body as {
          error: {
            message?: string;
            code?: number;
            error_subcode?: number;
            type?: string;
            fbtrace_id?: string;
          };
        }).error
      : null;

  throw new MetaApiError({
    message: err?.message ?? `Meta API request to ${path} failed (HTTP ${res.status})`,
    code: err?.code ?? null,
    subcode: err?.error_subcode ?? null,
    type: err?.type ?? null,
    httpStatus: res.status,
    fbtraceId: err?.fbtrace_id ?? null,
  });
}

/**
 * GET a single page from the Graph API. Always attaches access_token +
 * appsecret_proof. Internal — callers use `get()` which paginates.
 */
async function getOnePage<T>(
  url: string,
  token: string,
  path: string,
): Promise<MetaPagingResponse<T>> {
  const res = await fetch(url, {
    method: "GET",
    // Discovery reads live; never cache a token-bearing request.
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  logBusinessUseCaseUsage(res.headers, path);

  if (!res.ok) {
    await throwMetaError(res, path);
  }
  return (await res.json()) as MetaPagingResponse<T>;
}

/**
 * GET an edge and follow cursor pagination (paging.cursors.after) until exhausted,
 * returning all pages concatenated. `path` is relative (e.g. "act_123/campaigns").
 *
 * Pagination is REQUIRED here: campaigns/ads edges default to small page sizes and
 * silently miss most rows otherwise (docs §2.2).
 */
export async function get<T>(
  path: string,
  params: Record<string, ParamValue>,
  token: string,
): Promise<T[]> {
  const proof = appSecretProof(token);
  const out: T[] = [];

  // Build the first URL.
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    search.set(k, String(v));
  }
  search.set("access_token", token);
  search.set("appsecret_proof", proof);

  let url: string | null = `${baseUrl()}/${path}?${search.toString()}`;

  // Safety cap so a malformed cursor can never loop forever.
  const MAX_PAGES = 1000;
  let pages = 0;

  while (url && pages < MAX_PAGES) {
    const page: MetaPagingResponse<T> = await getOnePage<T>(url, token, path);
    if (page.data?.length) out.push(...page.data);

    const after = page.paging?.cursors?.after;
    if (after && page.data && page.data.length > 0) {
      const nextSearch = new URLSearchParams(search);
      nextSearch.set("after", after);
      url = `${baseUrl()}/${path}?${nextSearch.toString()}`;
    } else {
      url = null;
    }
    pages += 1;
  }

  return out;
}

/**
 * POST to the Graph API (writes). Sends params as application/x-www-form-urlencoded;
 * object/array values are JSON-stringified (Graph's convention for nested params like
 * object_story_spec). Always attaches access_token + appsecret_proof. `path` is
 * relative (e.g. "act_123/adcreatives"). Throws MetaApiError on a non-2xx response.
 *
 * WRITE SAFETY: every caller creates ads PAUSED and handles errors per-item; this
 * helper does no ret/backoff — the route serializes writes within the account.
 */
export async function post<T>(
  path: string,
  params: Record<string, unknown>,
  token: string,
): Promise<T> {
  const proof = appSecretProof(token);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  body.set("access_token", token);
  body.set("appsecret_proof", proof);

  const res = await fetch(`${baseUrl()}/${path}`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  logBusinessUseCaseUsage(res.headers, path);
  if (!res.ok) {
    await throwMetaError(res, path);
  }
  return (await res.json()) as T;
}

/**
 * GET a single object (not an edge) — used for lightweight health checks like
 * `GET /act_<id>?fields=name,account_status`. Returns the raw object.
 */
export async function getObject<T>(
  path: string,
  params: Record<string, ParamValue>,
  token: string,
): Promise<T> {
  const proof = appSecretProof(token);
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    search.set(k, String(v));
  }
  search.set("access_token", token);
  search.set("appsecret_proof", proof);

  const url = `${baseUrl()}/${path}?${search.toString()}`;
  const res = await fetch(url, {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  logBusinessUseCaseUsage(res.headers, path);
  if (!res.ok) {
    await throwMetaError(res, path);
  }
  return (await res.json()) as T;
}
