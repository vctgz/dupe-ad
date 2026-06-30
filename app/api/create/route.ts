// POST /api/create
// LIVE WRITE — creates fresh, page-bound ads (one per selected store), all PAUSED.
// This is the only mutating route. It is invoked solely from the modal's confirmed
// "Create paused ads" action; nothing here runs automatically.
//
// Safety contract (docs/01-meta-api-facts.md):
//   - session-locked to one ad account (a session for one account can't write another account's ads);
//   - requires real Meta write credentials (else 503 — the app otherwise runs
//     read-only in snapshot mode);
//   - every ad is created PAUSED for independent per-ad review (#7);
//   - writes are SERIALIZED within the account (#8);
//   - results are PER-STORE — one store failing never blocks the rest, and we never
//     claim blanket success.
//
// Scope: the from-scratch "Create new" flow with a single page-bound image creative.
// Live duplicate-mode cloning + multi-placement asset_feed_spec are follow-ups.
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAccountBySlug } from "@/config/accounts";
import { resolveDiscoveryResult } from "@/lib/discovery/resolve";
import { loadLandingUrls } from "@/lib/mapping";
import { authorizeAccount } from "@/lib/route-guard";
import { LiveCredentialsError } from "@/lib/env";
import { MetaApiError, resolveToken } from "@/lib/meta/client";
import {
  base64FromDataUrl,
  createCreative,
  createPausedAd,
  fetchAdsetsByCampaign,
  pickAdsetFromList,
  resolveTrackingPixelId,
  uploadImage,
} from "@/lib/meta/write";
import type { ApiError } from "@/lib/types";
import type { CampaignRow, DiscoveryResult } from "@/lib/discovery/types";

export const dynamic = "force-dynamic";
// Live writes fan out serialized across many stores; give the function headroom beyond
// Vercel's short default (60s is the Hobby ceiling; raise on Pro for very large batches).
export const maxDuration = 60;

// Meta call_to_action_type allow-list (mirrors the modal's CTA_OPTIONS). Anything
// outside this set is rejected rather than forwarded to the Graph API.
const CTA_TYPES = [
  "NO_BUTTON", "SHOP_NOW", "LEARN_MORE", "SIGN_UP", "SUBSCRIBE", "DOWNLOAD",
  "GET_OFFER", "GET_QUOTE", "GET_DIRECTIONS", "CALL_NOW", "ORDER_NOW", "BUY_NOW",
  "BOOK_TRAVEL", "CONTACT_US", "SEND_MESSAGE", "APPLY_NOW", "SEE_MENU",
  "REQUEST_TIME", "GET_SHOWTIMES", "LISTEN_NOW", "WATCH_MORE", "SAVE",
] as const;

const bodySchema = z.object({
  accountSlug: z.string().min(1),
  // Live writes currently support the from-scratch create flow only.
  mode: z.enum(["create", "duplicate"]).default("create"),
  adName: z.string().min(1).max(512),
  // Optional: target only ad sets whose name CONTAINS this (case-insensitive) in each
  // campaign. Omitted -> the campaign's active (else first) ad set.
  adsetName: z.string().trim().max(512).optional(),
  // Cap fan-out: bounds how many live writes a single request can trigger. Each
  // campaign is 2-3 serialized Graph calls, so 200 keeps a single run well-bounded.
  campaignIds: z.array(z.string().min(1).max(64)).min(1).max(200),
  creative: z.object({
    primaryText: z.string().min(1).max(2000),
    headline: z.string().min(1).max(255),
    subheadline: z.string().min(1).max(255),
    link: z.string().min(1).max(2048),
    cta: z.enum(CTA_TYPES).optional(),
  }),
  images: z
    .array(z.object({ placement: z.string().max(32).optional(), dataUrl: z.string().min(1) }))
    .min(1)
    .max(5),
});

export interface CreateAdResultRow {
  campaignId: string;
  storeCode: string | null;
  campaignName: string;
  ok: boolean;
  adId?: string;
  pageId?: string | null;
  error?: string;
}

export interface CreateAdsResponse {
  count: number;
  created: number;
  failed: number;
  results: CreateAdResultRow[];
  /** True when the run hit its time budget before processing every selected store. */
  timedOut?: boolean;
  /** Campaign ids not yet processed when timedOut — re-run just these. */
  remaining?: string[];
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<CreateAdsResponse | ApiError>> {
  // Reject oversized bodies before buffering them (one ~5MB image + JSON overhead).
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 12_000_000) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "unknown";
    return NextResponse.json({ error: `Invalid request (${where})` }, { status: 400 });
  }

  const { accountSlug, mode, adName, campaignIds, creative, images } = parsed.data;
  const adsetName = parsed.data.adsetName?.trim() || undefined;

  const authz = authorizeAccount(accountSlug);
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }
  if (mode !== "create") {
    return NextResponse.json(
      { error: "Live writes currently support the Create flow only. Duplicate is coming next." },
      { status: 400 },
    );
  }
  if (!isHttpUrl(creative.link)) {
    return NextResponse.json({ error: "A valid http(s) destination URL is required." }, { status: 400 });
  }

  const account = getAccountBySlug(accountSlug);
  if (!account) {
    return NextResponse.json({ error: `Unknown account "${accountSlug}"` }, { status: 400 });
  }

  // Resolve the write token — 503 (not a hard crash) when the app is in read-only
  // snapshot mode with no Meta credentials.
  let token: string;
  try {
    token = resolveToken(account);
  } catch (err) {
    if (err instanceof LiveCredentialsError) {
      return NextResponse.json(
        { error: "Live creation needs Meta write credentials (META_SYSTEM_USER_TOKEN + app secret)." },
        { status: 503 },
      );
    }
    throw err;
  }

  // Resolve each store's Page + IG identity + display name from the LIVE source — the
  // same campaign-bearing data the table reads. Pinned to "live" so a DISCOVERY_SOURCE of
  // "mapping"/"snapshot" can't hand back store-list rows (campaignId: null) that would make
  // every store fail. resolveToken above already guaranteed live creds are present.
  let discovery: DiscoveryResult;
  try {
    discovery = await resolveDiscoveryResult(account, "live");
  } catch (err) {
    if (err instanceof LiveCredentialsError) {
      return NextResponse.json(
        { error: "Live creation needs Meta credentials to read campaigns." },
        { status: 503 },
      );
    }
    const msg =
      err instanceof MetaApiError
        ? `Meta API error (${err.code ?? "?"}): ${err.message}`
        : err instanceof Error
          ? err.message
          : "Could not load campaigns.";
    return NextResponse.json({ error: `Could not load campaigns: ${msg}` }, { status: 502 });
  }
  const byId = new Map<string, CampaignRow>();
  for (const r of discovery.rows) {
    if (r.campaignId) byId.set(r.campaignId, r);
  }

  // Per-store landing pages from the mapping CSV's `url` column. When a store has
  // one, its ad links there; otherwise it falls back to the single Destination URL
  // from the modal (already validated as http(s) above).
  const landingUrls = await loadLandingUrls(account.slug);

  // Pick one image (square preferred), decode it, and reject anything oversized.
  const chosen = images.find((i) => i.placement === "square") ?? images[0]!;
  const base64 = base64FromDataUrl(chosen.dataUrl);
  if (!base64) {
    return NextResponse.json({ error: "Image must be a base64 image data URL." }, { status: 400 });
  }
  if (base64.length > 10_000_000) {
    return NextResponse.json({ error: "Image is too large (over ~7MB)." }, { status: 413 });
  }

  // Upload the image ONCE (account-scoped hash, reused across every store). Done AFTER
  // discovery so a discovery failure never leaves an orphan uploaded image.
  let imageHash: string;
  try {
    imageHash = await uploadImage(account, token, base64);
  } catch (err) {
    const msg =
      err instanceof MetaApiError
        ? `Meta API error (${err.code ?? "?"}): ${err.message}`
        : err instanceof Error
          ? err.message
          : "Image upload failed";
    return NextResponse.json({ error: `Could not upload the image: ${msg}` }, { status: 502 });
  }

  // Resolve the account's conversion pixel so created ads have "Website events" tracking
  // checked. Best-effort: if it can't be resolved, ads still create (just without it).
  let pixelId: string | null = null;
  try {
    pixelId = await resolveTrackingPixelId(account, token);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[create] could not resolve tracking pixel for ${account.slug}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Fetch the account's ad sets ONCE (grouped by campaign) so each store resolves its ad
  // set locally — cheaper than an /adsets call per store, and required to match a specific
  // ad-set name. A failure here is fatal (can't place ads without ad sets).
  let adsetsByCampaign: Awaited<ReturnType<typeof fetchAdsetsByCampaign>>;
  try {
    adsetsByCampaign = await fetchAdsetsByCampaign(token, account.id);
  } catch (err) {
    const msg =
      err instanceof MetaApiError
        ? `Meta API error (${err.code ?? "?"}): ${err.message}`
        : err instanceof Error
          ? err.message
          : "Could not load ad sets.";
    return NextResponse.json({ error: `Could not load ad sets: ${msg}` }, { status: 502 });
  }

  // SERIALIZE writes within the account (rate-limit safety, #8). Per-store results.
  // A wall-clock budget stops the loop before the function's maxDuration so we always
  // RETURN the results so far (with timedOut + remaining) instead of dying with no body —
  // the operator sees which stores succeeded and can re-run only the rest.
  const wanted = [...new Set(campaignIds)];
  const results: CreateAdResultRow[] = [];
  const startedAt = Date.now();
  const BUDGET_MS = 50_000;
  let timedOut = false;
  for (const campaignId of wanted) {
    if (Date.now() - startedAt > BUDGET_MS) {
      timedOut = true;
      break;
    }
    const row = byId.get(campaignId);
    const storeCode = row?.storeCode ?? null;
    const campaignName = row?.campaignName ?? "(unknown campaign)";
    try {
      const pageId = row?.mappedPage ?? row?.actualPage ?? null;
      if (!pageId) {
        results.push({
          campaignId, storeCode, campaignName, ok: false,
          error: "No Page resolved for this store — nothing to create the ad on.",
        });
        continue;
      }
      const pick = pickAdsetFromList(adsetsByCampaign.get(campaignId) ?? [], adsetName);
      if (pick.id === null) {
        results.push({
          campaignId, storeCode, campaignName, ok: false,
          error:
            pick.reason === "name-not-found"
              ? `No ad set matching "${adsetName}" in this campaign.`
              : "This campaign has no ad set to attach the ad to.",
        });
        continue;
      }
      const adsetId = pick.id;
      // This store's landing page wins over the modal's fallback URL. A mapped URL
      // that isn't http(s) fails just this store, with a clear message, rather than
      // silently sending its ad to the fallback.
      const storeUrl = storeCode ? landingUrls.get(storeCode) ?? null : null;
      const link = storeUrl ?? creative.link;
      if (!isHttpUrl(link)) {
        results.push({
          campaignId, storeCode, campaignName, ok: false,
          error: "This store's mapped landing URL is not a valid http(s) URL.",
        });
        continue;
      }
      const creativeId = await createCreative(account, token, {
        pageId,
        instagramUserId: row?.instagramUserId ?? null,
        imageHash,
        creative: { adName, ...creative, link },
      });
      const adId = await createPausedAd(account, token, { adsetId, creativeId, name: adName, pixelId });
      results.push({ campaignId, storeCode, campaignName, ok: true, adId, pageId });
    } catch (err) {
      const msg =
        err instanceof MetaApiError
          ? `Meta API error (${err.code ?? "?"}): ${err.message}`
          : err instanceof Error
            ? err.message
            : "Create failed";
      // eslint-disable-next-line no-console
      console.error(`[create] ${account.slug} campaign ${campaignId} failed: ${msg}`);
      results.push({ campaignId, storeCode, campaignName, ok: false, error: msg });
    }
  }

  const created = results.filter((r) => r.ok).length;
  const processed = new Set(results.map((r) => r.campaignId));
  return NextResponse.json({
    count: results.length,
    created,
    failed: results.length - created,
    results,
    timedOut,
    remaining: timedOut ? wanted.filter((id) => !processed.has(id)) : [],
  });
}
