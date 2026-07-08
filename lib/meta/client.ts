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
import { getEnv, requireLiveEnv, requireAppSecret } from "@/lib/env";
import type { AdAccount } from "@/config/accounts";

/** Typed Meta API error, parsed from Meta's `{ error: { ... } }` response body. */
export class MetaApiError extends Error {
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;
  readonly httpStatus: number;
  readonly fbtraceId: string | null;
  /** Meta's human-readable cause, when present (error_user_title / error_user_msg).
   *  Code 100 is a generic catch-all — these two are what actually name the bad param
   *  (e.g. "Your creative contains an invalid thumbnail"). null when Meta omits them. */
  readonly userTitle: string | null;
  readonly userMsg: string | null;
  /** For rate-limit errors: Meta's estimate (minutes) until access returns, from the
   *  usage headers on the failing response. null when unknown / not a rate limit. */
  readonly retryAfterMinutes: number | null;

  constructor(args: {
    message: string;
    code: number | null;
    subcode: number | null;
    type: string | null;
    httpStatus: number;
    fbtraceId?: string | null;
    userTitle?: string | null;
    userMsg?: string | null;
    retryAfterMinutes?: number | null;
  }) {
    super(args.message);
    this.name = "MetaApiError";
    this.code = args.code;
    this.subcode = args.subcode;
    this.type = args.type;
    this.httpStatus = args.httpStatus;
    this.fbtraceId = args.fbtraceId ?? null;
    this.userTitle = args.userTitle ?? null;
    this.userMsg = args.userMsg ?? null;
    this.retryAfterMinutes = args.retryAfterMinutes ?? null;
  }
}

/** Meta error codes that mean "you are being rate limited" (per-user, per-app, BUC). */
const RATE_LIMIT_CODES = new Set([
  4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014,
]);

/** True when an error is Meta telling us to slow down (any rate-limit code). */
export function isRateLimitError(err: unknown): err is MetaApiError & { code: number } {
  return (
    err instanceof MetaApiError && err.code != null && RATE_LIMIT_CODES.has(err.code)
  );
}

/**
 * A user-facing message for a MetaApiError. Rate-limit codes (e.g. 17 "User request limit
 * reached") get a clear, actionable line — with Meta's own regain estimate when the failing
 * response carried one — instead of the raw text; everything else shows the code + message.
 */
export function metaErrorToMessage(err: MetaApiError): string {
  if (isRateLimitError(err)) {
    if (err.retryAfterMinutes && err.retryAfterMinutes > 0) {
      const m = err.retryAfterMinutes;
      return `Meta's API rate limit was reached. Try again in about ${m} minute${m === 1 ? "" : "s"}.`;
    }
    return "Meta's API rate limit was reached — please wait a minute and try again.";
  }
  // Prefer Meta's human-readable cause over the generic code-100 "message", and include
  // the subcode when present — subcodes (e.g. 1487390 "Ad creative is invalid") and the
  // user message are what actually pinpoint an otherwise-opaque "Invalid parameter".
  const codeStr = err.subcode ? `${err.code ?? "?"}/${err.subcode}` : String(err.code ?? "?");
  const detail = err.userMsg?.trim() || err.userTitle?.trim() || err.message;
  return `Meta API error (${codeStr}): ${detail}`;
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

/** appsecret_proof = HMAC-SHA256(accessToken, app_secret), hex. Needs only the app
 *  secret — NOT a token — so an account using its own token override still works. */
function appSecretProof(accessToken: string): string {
  const secret = requireAppSecret();
  return createHmac("sha256", secret).update(accessToken).digest("hex");
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

/** A snapshot of how close we are to Meta's rate limits, from response headers. */
export interface MetaUsage {
  /** Worst-case utilization percent across all usage headers (0-100+). */
  utilizationPct: number;
  /** Meta's estimate (minutes) until throttled access returns; 0 when not throttled. */
  regainMinutes: number;
  /** Date.now() when this was observed. */
  observedAt: number;
}

// Latest observed usage per ad-account id (no act_ prefix). Per-process, best-effort:
// enough for the write loop to pace itself within one serverless invocation, which is
// exactly where a burst of calls happens.
const usageByAccount = new Map<string, MetaUsage>();

/** The most recently observed usage for an ad account, or null before any call. */
export function getMetaUsage(accountId: string): MetaUsage | null {
  return usageByAccount.get(accountId) ?? null;
}

/**
 * Parse Meta's three rate-limit headers into one worst-case snapshot:
 *   - X-Business-Use-Case-Usage: JSON keyed by ad-account id; entries carry call_count /
 *     total_cputime / total_time percents + estimated_time_to_regain_access (minutes).
 *   - X-Ad-Account-Usage: { acc_id_util_pct, reset_time_duration (seconds) }.
 *   - X-App-Usage: { call_count, total_time, total_cputime } percents.
 * Returns null when no usage header is present.
 */
function parseUsageHeaders(headers: Headers): MetaUsage | null {
  let worst = -1;
  let regain = 0;

  const buc = headers.get("x-business-use-case-usage");
  if (buc) {
    try {
      const parsed = JSON.parse(buc) as Record<
        string,
        Array<{
          call_count?: number;
          total_cputime?: number;
          total_time?: number;
          estimated_time_to_regain_access?: number;
        }>
      >;
      for (const entries of Object.values(parsed)) {
        for (const e of entries) {
          worst = Math.max(worst, e.call_count ?? 0, e.total_cputime ?? 0, e.total_time ?? 0);
          regain = Math.max(regain, e.estimated_time_to_regain_access ?? 0);
        }
      }
    } catch {
      // unparseable header — fall through to the others
    }
  }

  const acct = headers.get("x-ad-account-usage");
  if (acct) {
    try {
      const parsed = JSON.parse(acct) as {
        acc_id_util_pct?: number;
        reset_time_duration?: number;
      };
      worst = Math.max(worst, parsed.acc_id_util_pct ?? 0);
      regain = Math.max(regain, Math.ceil((parsed.reset_time_duration ?? 0) / 60));
    } catch {
      /* ignore */
    }
  }

  const app = headers.get("x-app-usage");
  if (app) {
    try {
      const parsed = JSON.parse(app) as {
        call_count?: number;
        total_time?: number;
        total_cputime?: number;
      };
      worst = Math.max(
        worst,
        parsed.call_count ?? 0,
        parsed.total_time ?? 0,
        parsed.total_cputime ?? 0,
      );
    } catch {
      /* ignore */
    }
  }

  if (worst < 0) return null;
  return { utilizationPct: worst, regainMinutes: regain, observedAt: Date.now() };
}

/**
 * Record the usage headers from a response against the ad account the call touched
 * (from the `act_<id>/...` path, else the BUC header's own account-id keys), log a
 * compact summary, and return the snapshot so error paths can attach it.
 */
function recordUsage(headers: Headers, path: string): MetaUsage | null {
  const usage = parseUsageHeaders(headers);
  if (!usage) return null;

  const ids = new Set<string>();
  const fromPath = /^act_(\d+)\//.exec(path);
  if (fromPath?.[1]) ids.add(fromPath[1]);
  const buc = headers.get("x-business-use-case-usage");
  if (buc) {
    try {
      for (const key of Object.keys(JSON.parse(buc) as Record<string, unknown>)) ids.add(key);
    } catch {
      /* ignore */
    }
  }
  for (const id of ids) usageByAccount.set(id, usage);

  // eslint-disable-next-line no-console
  console.info(
    `[meta] usage on ${path}: worst=${usage.utilizationPct}% regain=${usage.regainMinutes}min`,
  );
  return usage;
}

/** The shape of Meta's `{ error: { ... } }` body — every field it may carry that we read. */
interface MetaErrorFields {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
  fbtrace_id?: string;
  /** Human-readable cause — the load-bearing diagnostics for a generic code 100. */
  error_user_title?: string;
  error_user_msg?: string;
}

/** Pull Meta's `error` sub-object out of a parsed response/batch-op body, or null. */
function extractMetaError(body: unknown): MetaErrorFields | null {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error;
    if (e && typeof e === "object") return e as MetaErrorFields;
  }
  return null;
}

async function throwMetaError(
  res: Response,
  path: string,
  usage: MetaUsage | null,
): Promise<never> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON error body
  }
  const err = extractMetaError(body);

  const code = err?.code ?? null;
  throw new MetaApiError({
    message: err?.message ?? `Meta API request to ${path} failed (HTTP ${res.status})`,
    code,
    subcode: err?.error_subcode ?? null,
    type: err?.type ?? null,
    httpStatus: res.status,
    fbtraceId: err?.fbtrace_id ?? null,
    userTitle: err?.error_user_title ?? null,
    userMsg: err?.error_user_msg ?? null,
    // Only meaningful when Meta is throttling us; other errors leave it null.
    retryAfterMinutes:
      code != null && RATE_LIMIT_CODES.has(code) && usage && usage.regainMinutes > 0
        ? usage.regainMinutes
        : null,
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

  const usage = recordUsage(res.headers, path);

  if (!res.ok) {
    await throwMetaError(res, path, usage);
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

  const usage = recordUsage(res.headers, path);
  if (!res.ok) {
    await throwMetaError(res, path, usage);
  }
  return (await res.json()) as T;
}

/** One operation inside a Graph batch call. */
export interface BatchRequest {
  method: "GET" | "POST";
  /** e.g. "act_123/adcreatives" */
  relativeUrl: string;
  /** Form params; object/array values are JSON-stringified (Graph's convention). */
  params?: Record<string, unknown>;
  /** Batch op name — later ops can reference its result via `{result=<name>:$.id}`. */
  name?: string;
}

/**
 * Execute up to 50 Graph operations in ONE HTTP round trip (POST / with `batch`).
 * Ops run in order and may reference earlier NAMED ops' responses via JSONPath
 * (e.g. `{result=creative:$.id}`) — Meta's documented pattern for creating a
 * creative + its ad together.
 *
 * IMPORTANT: each sub-operation still counts toward rate limits. Batching halves
 * round-trip LATENCY, not quota — the pacing in the write loop stays load-bearing.
 *
 * Returns each op's parsed body in order (null for ops skipped because a
 * dependency failed). Throws a typed MetaApiError for the FIRST failed op, so
 * callers' rate-limit handling works exactly as with single calls.
 */
export async function postBatch<T = unknown>(
  ops: BatchRequest[],
  token: string,
): Promise<(T | null)[]> {
  const proof = appSecretProof(token);
  const batch = ops.map((op) => {
    const entry: Record<string, unknown> = {
      method: op.method,
      relative_url: op.relativeUrl,
    };
    if (op.name) {
      entry.name = op.name;
      // Named (referenced) ops have their responses omitted by default; we want
      // them back so partial failures are attributable.
      entry.omit_response_on_success = false;
    }
    if (op.params) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(op.params)) {
        if (v === undefined || v === null) continue;
        body.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
      entry.body = body.toString();
    }
    return entry;
  });

  const body = new URLSearchParams();
  body.set("batch", JSON.stringify(batch));
  body.set("include_headers", "false");
  body.set("access_token", token);
  body.set("appsecret_proof", proof);

  const res = await fetch(`${baseUrl()}/`, {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const usage = recordUsage(res.headers, ops[0]?.relativeUrl ?? "(batch)");
  if (!res.ok) {
    await throwMetaError(res, "(batch)", usage);
  }

  const arr = (await res.json()) as Array<{ code?: number; body?: string } | null>;
  const out: (T | null)[] = [];
  for (const [i, item] of arr.entries()) {
    if (!item) {
      out.push(null); // dependency failed -> op skipped
      continue;
    }
    let parsed: unknown = null;
    try {
      parsed = item.body ? JSON.parse(item.body) : null;
    } catch {
      // non-JSON op body
    }
    if (item.code != null && item.code >= 200 && item.code < 300) {
      out.push(parsed as T);
      continue;
    }
    // First failed op: surface it as a typed error (same shape as a single call).
    const errObj = extractMetaError(parsed);
    const code = errObj?.code ?? null;
    const relativeUrl = ops[i]?.relativeUrl ?? "?";
    // Which op failed + every diagnostic Meta returned. A creative/ad batch fails as a
    // whole otherwise-opaque code 100; naming the op (adcreatives vs ads) and dumping the
    // subcode + error_user_msg here is what makes the cause recoverable from the logs.
    // eslint-disable-next-line no-console
    console.error(
      `[meta] batch op ${i} (${relativeUrl}) failed: code=${code ?? "?"} ` +
        `subcode=${errObj?.error_subcode ?? "-"} http=${item.code ?? "?"} ` +
        `fbtrace=${errObj?.fbtrace_id ?? "-"}` +
        (errObj?.error_user_title ? ` title=${JSON.stringify(errObj.error_user_title)}` : "") +
        (errObj?.error_user_msg ? ` msg=${JSON.stringify(errObj.error_user_msg)}` : ""),
    );
    throw new MetaApiError({
      message:
        errObj?.message ??
        `Batch operation ${i} (${relativeUrl}) failed (HTTP ${item.code ?? "?"})`,
      code,
      subcode: errObj?.error_subcode ?? null,
      type: errObj?.type ?? null,
      httpStatus: item.code ?? 500,
      fbtraceId: errObj?.fbtrace_id ?? null,
      userTitle: errObj?.error_user_title ?? null,
      userMsg: errObj?.error_user_msg ?? null,
      retryAfterMinutes:
        code != null && RATE_LIMIT_CODES.has(code) && usage && usage.regainMinutes > 0
          ? usage.regainMinutes
          : null,
    });
  }
  return out;
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
  const usage = recordUsage(res.headers, path);
  if (!res.ok) {
    await throwMetaError(res, path, usage);
  }
  return (await res.json()) as T;
}
