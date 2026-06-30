// Meta Graph WRITE path — SERVER ONLY.
//
// Creates fresh, PAGE-BOUND ads, one per store, all PAUSED (docs/01-meta-api-facts
// #1, #3, #7). The cross-page fan-out is N brand-new creatives — one per store's
// Page — built from the SAME uploaded image_hash (account-scoped, uploaded once,
// #5). This is the from-scratch "Create new" engine; live duplicate-mode cloning
// and multi-placement asset_feed_spec are deliberate follow-ups.
//
// Nothing here is auto-run: the API route invokes it only on an explicit, confirmed
// user action, and every ad is created PAUSED for per-ad review.
import "server-only";
import { get, post } from "@/lib/meta/client";
import type { AdAccount } from "@/config/accounts";

export interface CreativeInput {
  adName: string;
  primaryText: string;
  headline: string;
  subheadline: string;
  link: string;
  /** call_to_action_type (e.g. SHOP_NOW). "" / "NO_BUTTON" → no button. */
  cta?: string;
}

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

/**
 * Fetch ALL ad sets in an account in one paginated pull and group them by campaign id.
 * One account-level read is far cheaper than an /adsets call per campaign when creating
 * (or previewing) across many stores.
 */
export async function fetchAdsetsByCampaign(
  token: string,
  accountId: string,
): Promise<Map<string, MetaAdset[]>> {
  const adsets = await get<MetaAdset>(
    `act_${accountId}/adsets`,
    { fields: "id,name,effective_status,campaign_id", limit: 200 },
    token,
  );
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
 * never run). With `adsetName`, match it by EXACT (case-insensitive) name, preferring an
 * ACTIVE one when several share the name; without, prefer an ACTIVE set, else the first
 * deliverable. Returns a `reason` when nothing usable matches so callers can message
 * precisely. An ad MUST live in an ad set (there is no page/ad-set-level page field — #2).
 */
export function pickAdsetFromList(adsets: MetaAdset[], adsetName?: string): AdsetPick {
  if (adsets.length === 0) return { id: null, reason: "no-adsets" };
  const usable = adsets.filter(isDeliverableAdset);
  const want = (adsetName ?? "").trim();
  if (want) {
    const target = want.toLowerCase();
    const matches = usable.filter((a) => (a.name ?? "").trim().toLowerCase() === target);
    if (matches.length === 0) return { id: null, reason: "name-not-found" };
    const chosen = preferActive(matches);
    return { id: chosen.id, name: chosen.name ?? "" };
  }
  if (usable.length === 0) return { id: null, reason: "no-adsets" };
  const chosen = preferActive(usable);
  return { id: chosen.id, name: chosen.name ?? "" };
}

/**
 * Create a single-image, page-bound creative (object_story_spec.link_data) and
 * return its id. The page binding is immutable once set — this is a NEW creative
 * for THIS store's Page (#1). `link_data.link` is mirrored into
 * `call_to_action.value.link` as Meta requires (#4).
 */
export async function createCreative(
  account: AdAccount,
  token: string,
  args: {
    pageId: string;
    instagramUserId?: string | null;
    imageHash: string;
    creative: CreativeInput;
  },
): Promise<string> {
  const { pageId, instagramUserId, imageHash, creative } = args;
  const useCta = !!creative.cta && creative.cta !== "NO_BUTTON";

  const linkData: Record<string, unknown> = {
    message: creative.primaryText,
    name: creative.headline,
    description: creative.subheadline,
    link: creative.link,
    image_hash: imageHash,
  };
  if (useCta) {
    linkData.call_to_action = { type: creative.cta, value: { link: creative.link } };
  }

  const objectStorySpec: Record<string, unknown> = {
    page_id: pageId,
    link_data: linkData,
  };
  if (instagramUserId) objectStorySpec.instagram_user_id = instagramUserId;

  const res = await post<{ id?: string }>(
    `act_${account.id}/adcreatives`,
    { name: `${creative.adName} — creative`, object_story_spec: objectStorySpec },
    token,
  );
  if (!res.id) throw new Error("Creative creation did not return an id.");
  return res.id;
}

interface MetaPixel {
  id: string;
  is_unavailable?: boolean;
}

// In-process cache of the resolved tracking pixel per account slug (rarely changes).
const pixelCache = new Map<string, string | null>();

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
  const pixels = await get<MetaPixel>(
    `act_${account.id}/adspixels`,
    { fields: "id,is_unavailable", limit: 50 },
    token,
  );
  const usable = pixels.find((p) => p.id && p.is_unavailable !== true) ?? pixels[0] ?? null;
  const pixelId = usable && usable.id ? usable.id : null;
  pixelCache.set(account.slug, pixelId);
  return pixelId;
}

/**
 * Create a PAUSED ad from a creative; returns the ad id (#7 — always PAUSED). When a
 * `pixelId` is supplied, the ad tracks website events against it (so the "Website events"
 * box in the ad's Tracking section is checked); Meta auto-adds the rest of the tracking
 * specs (onsite/page engagement).
 */
export async function createPausedAd(
  account: AdAccount,
  token: string,
  args: { adsetId: string; creativeId: string; name: string; pixelId?: string | null },
): Promise<string> {
  const params: Record<string, unknown> = {
    name: args.name,
    adset_id: args.adsetId,
    creative: { creative_id: args.creativeId },
    status: "PAUSED",
  };
  if (args.pixelId) {
    params.tracking_specs = [
      { "action.type": ["offsite_conversion"], fb_pixel: [args.pixelId] },
    ];
  }
  const res = await post<{ id?: string }>(`act_${account.id}/ads`, params, token);
  if (!res.id) throw new Error("Ad creation did not return an id.");
  return res.id;
}
