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
import { MetaApiError, get, getObject, post, postBatch } from "@/lib/meta/client";
import { kvGet, kvSet } from "@/lib/kv";
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

/** One carousel card. The image hash is account-scoped (uploaded once, reused). */
export interface CarouselCardSpec {
  imageHash: string;
  headline: string;
  description?: string;
  /** Per-card destination. Absent -> the creative's (per-store) link. */
  link?: string;
}

/**
 * What a creative displays. All variants are page-bound and reuse account-scoped
 * assets (image hashes / video ids), so the caller uploads each asset ONCE and
 * fans the SAME content out across every store's Page (#5).
 */
export type CreativeContent =
  | { kind: "image"; imageHash: string }
  | { kind: "video"; videoId: string; thumbnailHash: string }
  | { kind: "carousel"; cards: CarouselCardSpec[] };

/**
 * Build the object_story_spec payload for a creative. Exported for the create route's
 * batch path; most callers want createCreative().
 *
 *   image    — link_data: `link` mirrored into call_to_action.value.link (#4).
 *   video    — video_data: NO top-level link field exists; the destination lives ONLY in
 *              call_to_action.value.link, so a real CTA is REQUIRED. A thumbnail
 *              image_hash is also required or Meta rejects the creative.
 *   carousel — link_data with child_attachments (2-10 cards). A card without its own
 *              link inherits the creative's (per-store) link, so mapped landing pages
 *              keep working card by card.
 */
export function buildObjectStorySpec(args: {
  pageId: string;
  instagramUserId?: string | null;
  content: CreativeContent;
  creative: CreativeInput;
}): Record<string, unknown> {
  const { pageId, instagramUserId, content, creative } = args;
  const useCta = !!creative.cta && creative.cta !== "NO_BUTTON";

  const objectStorySpec: Record<string, unknown> = { page_id: pageId };
  if (instagramUserId) objectStorySpec.instagram_user_id = instagramUserId;

  if (content.kind === "video") {
    if (!useCta) {
      throw new Error(
        "Video creatives need a call-to-action button to carry the destination link.",
      );
    }
    objectStorySpec.video_data = {
      video_id: content.videoId,
      image_hash: content.thumbnailHash,
      title: creative.headline,
      message: creative.primaryText,
      link_description: creative.subheadline,
      call_to_action: { type: creative.cta, value: { link: creative.link } },
    };
    return objectStorySpec;
  }

  if (content.kind === "carousel") {
    const childAttachments = content.cards.map((card) => {
      const cardLink = card.link && card.link.trim().length > 0 ? card.link : creative.link;
      const attachment: Record<string, unknown> = {
        link: cardLink,
        image_hash: card.imageHash,
        name: card.headline,
      };
      if (card.description && card.description.trim().length > 0) {
        attachment.description = card.description;
      }
      if (useCta) {
        attachment.call_to_action = { type: creative.cta, value: { link: cardLink } };
      }
      return attachment;
    });
    objectStorySpec.link_data = {
      message: creative.primaryText,
      // The carousel's own destination (the "see more" surface / end behavior).
      link: creative.link,
      child_attachments: childAttachments,
      // Keep the operator's card order — don't let Meta reshuffle by performance —
      // and skip the auto-generated Page end card.
      multi_share_optimized: false,
      multi_share_end_card: false,
    };
    return objectStorySpec;
  }

  const linkData: Record<string, unknown> = {
    message: creative.primaryText,
    name: creative.headline,
    description: creative.subheadline,
    link: creative.link,
    image_hash: content.imageHash,
  };
  if (useCta) {
    linkData.call_to_action = { type: creative.cta, value: { link: creative.link } };
  }
  objectStorySpec.link_data = linkData;
  return objectStorySpec;
}

/**
 * Create a page-bound creative (image link_data or video video_data) and return its
 * id. The page binding is immutable once set — this is a NEW creative for THIS
 * store's Page (#1).
 */
export async function createCreative(
  account: AdAccount,
  token: string,
  args: {
    pageId: string;
    instagramUserId?: string | null;
    content: CreativeContent;
    creative: CreativeInput;
  },
): Promise<string> {
  const res = await post<{ id?: string }>(
    `act_${account.id}/adcreatives`,
    {
      name: `${args.creative.adName} — creative`,
      object_story_spec: buildObjectStorySpec(args),
    },
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

/**
 * Create a store's creative AND its PAUSED ad in ONE batched HTTP round trip: two
 * dependent Graph batch ops, with the ad referencing the creative via Meta's
 * documented JSONPath form ({result=creative:$.id}). Same semantics and safety as
 * createCreative() + createPausedAd() — half the per-store latency. Both operations
 * still count toward rate limits individually.
 */
export async function createCreativeAndPausedAd(
  account: AdAccount,
  token: string,
  args: {
    pageId: string;
    instagramUserId?: string | null;
    content: CreativeContent;
    creative: CreativeInput;
    adsetId: string;
    pixelId?: string | null;
  },
): Promise<string> {
  const adParams: Record<string, unknown> = {
    name: args.creative.adName,
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
        params: {
          name: `${args.creative.adName} — creative`,
          object_story_spec: buildObjectStorySpec(args),
        },
      },
      { method: "POST", relativeUrl: `act_${account.id}/ads`, params: adParams },
    ],
    token,
  );
  if (!creativeRes?.id) throw new Error("Creative creation did not return an id.");
  if (!adRes?.id) throw new Error("Ad creation did not return an id.");
  return adRes.id;
}
