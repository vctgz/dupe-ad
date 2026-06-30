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
}

/**
 * Pick an ad set under a campaign to attach the new ad to. An ad MUST live in an
 * ad set (there is no page/ad-set-level page field — #2). Prefer an ACTIVE set,
 * else the first. Returns null when the campaign has no ad set (reported per-store).
 */
export async function pickAdsetId(
  token: string,
  campaignId: string,
): Promise<string | null> {
  const adsets = await get<MetaAdset>(
    `${campaignId}/adsets`,
    { fields: "id,name,effective_status", limit: 100 },
    token,
  );
  if (adsets.length === 0) return null;
  const active = adsets.find((a) => (a.effective_status ?? "").toUpperCase() === "ACTIVE");
  return (active ?? adsets[0]!).id;
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
