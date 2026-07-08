// Meta Graph WRITE path — SERVER ONLY.
//
// Creates fresh, PAGE-BOUND ads, one per store, all PAUSED (docs/01-meta-api-facts
// #1, #3, #7). Two engines share this module:
//   Create    — N brand-new creatives, one per store's Page, built from the SAME
//               freshly-uploaded image_hash / video_id (account-scoped, uploaded
//               once, #5).
//   Duplicate — clones an EXISTING ad (found by exact name within each selected
//               campaign) onto that same store's Page: its own account-scoped
//               assets are reused as-is (nothing re-uploaded), and only the
//               copy/link/CTA fields the operator explicitly overrides change —
//               a multi-aspect asset_feed_spec carries every ratio over unchanged.
// Multi-placement asset_feed_spec for STATIC IMAGES (Create mode) is still a
// follow-up (video already ships it; Duplicate mode carries over whatever the
// source ad already has, image or video).
//
// Nothing here is auto-run: the API route invokes it only on an explicit, confirmed
// user action, and every ad is created PAUSED for per-ad review.
import "server-only";
import { MetaApiError, get, getObject, post, postBatch } from "@/lib/meta/client";
import { kvGet, kvSet } from "@/lib/kv";
import type { AdAccount } from "@/config/accounts";
import type { DuplicateSourceCreative } from "@/lib/meta/creative-spec";

// Creative-shape builders + their types live in the pure (server-only-free) module so
// they can be unit-tested in isolation. Re-exported here so existing importers keep
// pulling them from "@/lib/meta/write".
export {
  buildCreativeParams,
  buildVideoAssetRules,
  buildDuplicateCreativeParams,
  sourceInstagramId,
} from "@/lib/meta/creative-spec";
export type {
  CreativeInput,
  CreativeContent,
  CarouselCardSpec,
  VideoPlacement,
  VideoPlacementKey,
  VideoAssetRule,
  DuplicateSourceCreative,
  DuplicateOverrides,
} from "@/lib/meta/creative-spec";

/** Strip a `data:image/...;base64,` prefix, returning the bare base64 payload. */
export function base64FromDataUrl(dataUrl: string): string | null {
  const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/s.exec(dataUrl.trim());
  return m ? m[1]! : null;
}

/**
 * Upload one base64 image to the ad account and return its image_hash. The hash is
 * account-scoped, so the caller uploads ONCE and reuses it across every store (#5).
 */
export async function uploadImage(
  account: AdAccount,
  token: string,
  base64: string,
): Promise<string> {
  const res = await post<{ images?: Record<string, { hash?: string }> }>(
    `act_${account.id}/adimages`,
    { bytes: base64 },
    token,
  );
  const first = res.images ? Object.values(res.images)[0] : undefined;
  if (!first?.hash) {
    throw new Error("Image upload did not return a hash.");
  }
  return first.hash;
}

/**
 * Register a video against the ad account by URL — Meta downloads the file itself
 * (`file_url`), so nothing large ever flows through this serverless function. The
 * returned video id is ACCOUNT-scoped like an image hash: register ONCE, reuse the
 * id across every store's creative. Processing is ASYNC — poll getVideoStatus()
 * until "ready" before building creatives on it.
 */
export async function registerVideoFromUrl(
  account: AdAccount,
  token: string,
  fileUrl: string,
  name?: string,
): Promise<string> {
  const params: Record<string, unknown> = { file_url: fileUrl };
  if (name && name.trim().length > 0) params.name = name.trim();
  const res = await post<{ id?: string }>(`act_${account.id}/advideos`, params, token);
  if (!res.id) {
    throw new Error("Video registration did not return an id.");
  }
  return res.id;
}

export interface VideoStatus {
  status: "ready" | "processing" | "error";
  /** Meta's processing percent when reported, else null. */
  progress: number | null;
}

/** Poll a registered video's processing state (GET /<video_id>?fields=status). */
export async function getVideoStatus(token: string, videoId: string): Promise<VideoStatus> {
  const res = await getObject<{
    status?: { video_status?: string; processing_progress?: number };
  }>(videoId, { fields: "status" }, token);
  const raw = (res.status?.video_status ?? "processing").toLowerCase();
  const status = raw === "ready" ? "ready" : raw === "error" ? "error" : "processing";
  return { status, progress: res.status?.processing_progress ?? null };
}

interface MetaAdset {
  id: string;
  name?: string;
  effective_status?: string;
  campaign_id?: string;
}

/** Result of resolving which ad set a new ad should go into. */
export type AdsetPick =
  | { id: string; name: string }
  | { id: null; reason: "no-adsets" | "name-not-found" };

// Page sizes for the account-level /adsets pull, largest first. Four flat fields
// make these cheap rows, so big pages are usually fine; back off on Meta error #1
// ("reduce the amount of data") the same way discovery's /ads pull does.
const ADSET_PAGE_SIZES = [500, 200, 50] as const;

/**
 * Fetch ALL ad sets in an account in one paginated pull and group them by campaign id.
 * One account-level read is far cheaper than an /adsets call per campaign when creating
 * (or previewing) across many stores.
 */
export async function fetchAdsetsByCampaign(
  token: string,
  accountId: string,
): Promise<Map<string, MetaAdset[]>> {
  let adsets: MetaAdset[] | null = null;
  let lastErr: unknown;
  for (const limit of ADSET_PAGE_SIZES) {
    try {
      adsets = await get<MetaAdset>(
        `act_${accountId}/adsets`,
        { fields: "id,name,effective_status,campaign_id", limit },
        token,
      );
      break;
    } catch (err) {
      if (err instanceof MetaApiError && err.code === 1) {
        lastErr = err;
        // eslint-disable-next-line no-console
        console.warn(`[meta] /adsets too large at limit=${limit}; backing off`);
        continue;
      }
      throw err;
    }
  }
  if (adsets === null) throw lastErr;
  const byCampaign = new Map<string, MetaAdset[]>();
  for (const a of adsets) {
    if (!a.campaign_id) continue;
    const list = byCampaign.get(a.campaign_id);
    if (list) list.push(a);
    else byCampaign.set(a.campaign_id, [a]);
  }
  return byCampaign;
}

/** ARCHIVED/DELETED ad sets can't run, so we never publish into them. */
const NON_DELIVERABLE_ADSET = new Set(["ARCHIVED", "DELETED"]);
function isDeliverableAdset(a: MetaAdset): boolean {
  return !NON_DELIVERABLE_ADSET.has((a.effective_status ?? "").toUpperCase());
}
function preferActive(adsets: MetaAdset[]): MetaAdset {
  return adsets.find((a) => (a.effective_status ?? "").toUpperCase() === "ACTIVE") ?? adsets[0]!;
}

/**
 * Pick which ad set a new ad goes into, from a campaign's ad sets. Only ever considers
 * DELIVERABLE ad sets (an account-level /adsets read includes ARCHIVED ones, which would
 * never run). With `adsetName`, match any ad set whose name CONTAINS it (case-insensitive),
 * preferring an ACTIVE one when several match; without, prefer an ACTIVE set, else the first
 * deliverable. Returns a `reason` when nothing usable matches so callers can message
 * precisely. An ad MUST live in an ad set (there is no page/ad-set-level page field — #2).
 */
export function pickAdsetFromList(adsets: MetaAdset[], adsetName?: string): AdsetPick {
  if (adsets.length === 0) return { id: null, reason: "no-adsets" };
  const usable = adsets.filter(isDeliverableAdset);
  const want = (adsetName ?? "").trim();
  if (want) {
    const target = want.toLowerCase();
    const matches = usable.filter((a) => (a.name ?? "").trim().toLowerCase().includes(target));
    if (matches.length === 0) return { id: null, reason: "name-not-found" };
    const chosen = preferActive(matches);
    return { id: chosen.id, name: chosen.name ?? "" };
  }
  if (usable.length === 0) return { id: null, reason: "no-adsets" };
  const chosen = preferActive(usable);
  return { id: chosen.id, name: chosen.name ?? "" };
}

// Page sizes for a per-campaign, name-filtered /ads pull, largest first. Mirrors
// discovery's account-level Template pull (lib/meta/discovery.ts): a server-side
// CONTAIN filter keeps the pull small even on campaigns with a long paused-ad
// history, and we back off on Meta error #1 before giving up.
const SOURCE_AD_PAGE_SIZES = [50, 20, 5] as const;

interface MetaSourceAd {
  id: string;
  name?: string;
  effective_status?: string;
  creative?: {
    object_story_spec?: Record<string, unknown>;
    asset_feed_spec?: Record<string, unknown>;
  };
}

/**
 * Find the ad named `adName` (case-insensitive EXACT match — matching the modal's
 * "exact ad name" contract; ACTIVE preferred among ties) within ONE campaign, and
 * return its full creative shape for DUPLICATE mode. The destination ad reuses
 * these account-scoped asset references (image_hash / video_id) directly — nothing
 * is re-uploaded. Returns null when no ad in this campaign matches.
 */
export async function findSourceAdCreative(
  token: string,
  campaignId: string,
  adName: string,
): Promise<DuplicateSourceCreative | null> {
  const filtering = JSON.stringify([{ field: "name", operator: "CONTAIN", value: adName }]);
  let ads: MetaSourceAd[] | null = null;
  let lastErr: unknown;
  for (const limit of SOURCE_AD_PAGE_SIZES) {
    try {
      ads = await get<MetaSourceAd>(
        `${campaignId}/ads`,
        {
          fields: "id,name,effective_status,creative{object_story_spec,asset_feed_spec}",
          limit,
          filtering,
        },
        token,
      );
      break;
    } catch (err) {
      if (err instanceof MetaApiError && err.code === 1) {
        lastErr = err;
        // eslint-disable-next-line no-console
        console.warn(`[meta] ${campaignId}/ads too large at limit=${limit}; backing off`);
        continue;
      }
      throw err;
    }
  }
  if (ads === null) throw lastErr;

  const target = adName.trim().toLowerCase();
  const matches = ads.filter((a) => (a.name ?? "").trim().toLowerCase() === target);
  if (matches.length === 0) return null;
  const chosen =
    matches.find((a) => (a.effective_status ?? "").toUpperCase() === "ACTIVE") ?? matches[0]!;
  return {
    objectStorySpec: chosen.creative?.object_story_spec ?? null,
    assetFeedSpec: chosen.creative?.asset_feed_spec ?? null,
  };
}

interface MetaPixel {
  id: string;
  is_unavailable?: boolean;
}

// In-process cache of the resolved tracking pixel per account slug (rarely changes).
// Two-tier: this Map is L1 (one instance), the shared KV store is L2 (survives cold
// starts and covers sibling instances). KV is optional; without it L1 alone applies.
const pixelCache = new Map<string, string | null>();
const PIXEL_KV_TTL_SEC = 6 * 3600;

/**
 * Resolve the conversion pixel to track website events against for an account: the
 * account's configured `pixelId` when set, else the first AVAILABLE pixel on the account
 * (act_<id>/adspixels). Returns null when the account has no pixel — the ad is then created
 * WITHOUT website-event tracking rather than failing. Cached per account.
 */
export async function resolveTrackingPixelId(
  account: AdAccount,
  token: string,
): Promise<string | null> {
  if (account.pixelId && account.pixelId.trim().length > 0) {
    return account.pixelId.trim();
  }
  const cached = pixelCache.get(account.slug);
  if (cached !== undefined) return cached;

  // Wrapped in an object so a legitimately-null pixel is distinguishable from a miss.
  const kvKey = `dupe:pixel:${account.slug}`;
  const fromKv = await kvGet<{ pixelId: string | null }>(kvKey);
  if (fromKv) {
    pixelCache.set(account.slug, fromKv.pixelId);
    return fromKv.pixelId;
  }

  const pixels = await get<MetaPixel>(
    `act_${account.id}/adspixels`,
    { fields: "id,is_unavailable", limit: 50 },
    token,
  );
  const usable = pixels.find((p) => p.id && p.is_unavailable !== true) ?? pixels[0] ?? null;
  const pixelId = usable && usable.id ? usable.id : null;
  pixelCache.set(account.slug, pixelId);
  await kvSet(kvKey, { pixelId }, PIXEL_KV_TTL_SEC);
  return pixelId;
}

/**
 * Create a store's creative AND its PAUSED ad in ONE batched HTTP round trip: two
 * dependent Graph batch ops, with the ad referencing the creative via Meta's
 * documented JSONPath form ({result=creative:$.id}) — half the per-store latency of
 * two separate calls. Both operations still count toward rate limits individually.
 *
 * Mode-agnostic by design: the caller builds `creativeParams` itself, via
 * buildCreativeParams() for Create (fresh media) or buildDuplicateCreativeParams()
 * for Duplicate (cloned from an existing ad) — this function only needs the final
 * params object plus the ad-level fields (name, ad set, pixel).
 */
export async function createCreativeAndPausedAd(
  account: AdAccount,
  token: string,
  args: {
    adName: string;
    creativeParams: Record<string, unknown>;
    adsetId: string;
    pixelId?: string | null;
  },
): Promise<string> {
  const adParams: Record<string, unknown> = {
    name: args.adName,
    adset_id: args.adsetId,
    creative: { creative_id: "{result=creative:$.id}" },
    status: "PAUSED",
  };
  if (args.pixelId) {
    adParams.tracking_specs = [
      { "action.type": ["offsite_conversion"], fb_pixel: [args.pixelId] },
    ];
  }
  const [creativeRes, adRes] = await postBatch<{ id?: string }>(
    [
      {
        method: "POST",
        name: "creative",
        relativeUrl: `act_${account.id}/adcreatives`,
        params: args.creativeParams,
      },
      { method: "POST", relativeUrl: `act_${account.id}/ads`, params: adParams },
    ],
    token,
  );
  if (!creativeRes?.id) throw new Error("Creative creation did not return an id.");
  if (!adRes?.id) throw new Error("Ad creation did not return an id.");
  return adRes.id;
}
