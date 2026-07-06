// Creative-shape builders — PURE, no I/O, no server-only deps.
//
// These turn typed copy + account-scoped asset references (image hashes / video ids)
// into the exact `POST act_<id>/adcreatives` params Meta expects, for each format:
// static image, carousel, single video, and multi-aspect video (asset_feed_spec).
//
// Kept free of `server-only` / the Graph client on purpose: the write path
// (lib/meta/write.ts) re-exports everything here, and these functions are unit-tested
// directly (see lib/meta/creative-spec.test.ts) without booting the whole write stack.

export interface CreativeInput {
  adName: string;
  primaryText: string;
  headline: string;
  subheadline: string;
  link: string;
  /** call_to_action_type (e.g. SHOP_NOW). "" / "NO_BUTTON" → no button. */
  cta?: string;
}

/** One carousel card. The image hash is account-scoped (uploaded once, reused). */
export interface CarouselCardSpec {
  imageHash: string;
  headline: string;
  description?: string;
  /** Per-card destination. Absent -> the creative's (per-store) link. */
  link?: string;
}

/** The three video aspect-ratio slots an operator can upload, one per placement. */
export type VideoPlacementKey = "square" | "vertical" | "horizontal";

/** One uploaded, already-READY, account-scoped video bound to its aspect slot. */
export interface VideoPlacement {
  placement: VideoPlacementKey;
  videoId: string;
}

/**
 * What a creative displays. All variants are page-bound and reuse account-scoped
 * assets (image hashes / video ids), so the caller uploads each asset ONCE and
 * fans the SAME content out across every store's Page (#5).
 *
 * `video` carries 1-3 aspect slots. ONE video keeps the proven single-video
 * `video_data` shape; TWO OR MORE build an `asset_feed_spec` that serves each
 * ratio to its matching placement (Stories/Reels ← vertical, feed ← square,
 * in-stream ← horizontal). A single square `thumbnailHash` covers every slot.
 */
export type CreativeContent =
  | { kind: "image"; imageHash: string }
  | { kind: "video"; videos: VideoPlacement[]; thumbnailHash: string }
  | { kind: "carousel"; cards: CarouselCardSpec[] };

/** Stable adlabel names for the three video aspect slots (#4 — labels must match). */
const VIDEO_LABELS: Record<VideoPlacementKey, string> = {
  square: "VID_SQUARE",
  vertical: "VID_VERTICAL",
  horizontal: "VID_HORIZONTAL",
};

/** One placement customization bucket: its Graph positions + the slot it prefers. */
interface PlacementBucket {
  publisherPlatforms: string[];
  facebookPositions: string[];
  instagramPositions?: string[];
  /** Fallback order for which uploaded slot serves this bucket (first present wins). */
  preference: VideoPlacementKey[];
}

// The video placement buckets, in PRIORITY order. Their positions are mutually
// exclusive by construction, so merging any two into one rule keeps them exclusive.
//   Stories/Reels ← vertical, Feed ← square, Wide (in-stream/search) ← horizontal.
// A bucket whose preferred slot wasn't uploaded folds onto the next present slot.
const PLACEMENT_BUCKETS: PlacementBucket[] = [
  {
    publisherPlatforms: ["facebook", "instagram"],
    facebookPositions: ["story", "facebook_reels"],
    instagramPositions: ["story", "reels"],
    preference: ["vertical", "square", "horizontal"],
  },
  {
    publisherPlatforms: ["facebook", "instagram"],
    facebookPositions: ["feed"],
    instagramPositions: ["stream"],
    preference: ["square", "vertical", "horizontal"],
  },
  {
    publisherPlatforms: ["facebook"],
    facebookPositions: ["instream_video", "search"],
    preference: ["horizontal", "square", "vertical"],
  },
];

/** A resolved placement rule inside asset_feed_spec.asset_customization_rules. */
export interface VideoAssetRule {
  customization_spec: {
    publisher_platforms: string[];
    facebook_positions: string[];
    instagram_positions?: string[];
  };
  video_label: { name: string };
  priority: number;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

/**
 * Map each placement bucket to the uploaded video slot it should serve (folding onto
 * a present fallback when its preferred ratio was skipped), then MERGE buckets that
 * landed on the same slot into one rule so the buckets stay mutually exclusive.
 * Priorities are assigned 1..n in bucket (table) order.
 *
 * Pure + exported for unit tests — this is the part `error_subcode 1487390` punishes:
 * every `video_label` it emits is guaranteed present in `present`, and with >= 2 slots
 * present it always yields >= 2 rules (PLACEMENT requires more than one — #4).
 */
export function buildVideoAssetRules(present: Set<VideoPlacementKey>): VideoAssetRule[] {
  // Resolve each bucket to a present slot, preserving first-seen label order.
  const byLabel = new Map<
    string,
    { publisher: string[]; facebook: string[]; instagram: string[] }
  >();
  const order: string[] = [];
  for (const bucket of PLACEMENT_BUCKETS) {
    const slot = bucket.preference.find((k) => present.has(k));
    if (!slot) continue; // impossible when present is non-empty, but stay defensive
    const label = VIDEO_LABELS[slot];
    let entry = byLabel.get(label);
    if (!entry) {
      entry = { publisher: [], facebook: [], instagram: [] };
      byLabel.set(label, entry);
      order.push(label);
    }
    entry.publisher.push(...bucket.publisherPlatforms);
    entry.facebook.push(...bucket.facebookPositions);
    if (bucket.instagramPositions) entry.instagram.push(...bucket.instagramPositions);
  }

  return order.map((label, i) => {
    const e = byLabel.get(label)!;
    const spec: VideoAssetRule["customization_spec"] = {
      publisher_platforms: uniq(e.publisher),
      facebook_positions: uniq(e.facebook),
    };
    if (e.instagram.length > 0) spec.instagram_positions = uniq(e.instagram);
    return { customization_spec: spec, video_label: { name: label }, priority: i + 1 };
  });
}

/**
 * Build the multi-aspect `asset_feed_spec` for >= 2 uploaded videos: one labeled
 * `videos[]` entry per slot (all sharing the square thumbnail — #6), the copy/link/CTA
 * hoisted into feed-spec arrays (#5), and the placement rules from buildVideoAssetRules.
 */
function buildVideoAssetFeedSpec(
  videos: VideoPlacement[],
  thumbnailHash: string,
  creative: CreativeInput,
): Record<string, unknown> {
  const present = new Set(videos.map((v) => v.placement));
  return {
    ad_formats: ["SINGLE_VIDEO"],
    optimization_type: "PLACEMENT",
    videos: videos.map((v) => ({
      video_id: v.videoId,
      thumbnail_hash: thumbnailHash,
      adlabels: [{ name: VIDEO_LABELS[v.placement] }],
    })),
    bodies: [{ text: creative.primaryText }],
    titles: [{ text: creative.headline }],
    descriptions: [{ text: creative.subheadline }],
    link_urls: [{ website_url: creative.link }],
    call_to_action_types: [creative.cta],
    asset_customization_rules: buildVideoAssetRules(present),
  };
}

/**
 * Build the full `POST act_<id>/adcreatives` params for a creative — `{ name,
 * object_story_spec, asset_feed_spec? }`. Exported for the create route's batch path;
 * most callers want createCreative().
 *
 *   image         — link_data: `link` mirrored into call_to_action.value.link (#4).
 *   video (1)     — video_data: NO top-level link field exists; the destination lives
 *                   ONLY in call_to_action.value.link, so a real CTA is REQUIRED. A
 *                   thumbnail image_hash is also required or Meta rejects the creative.
 *   video (>= 2)  — object_story_spec carries ONLY the page/IG identity; the videos,
 *                   copy, link, CTA, and per-placement rules live in asset_feed_spec so
 *                   each ratio serves its matching placement.
 *   carousel      — link_data with child_attachments (2-10 cards). A card without its own
 *                   link inherits the creative's (per-store) link, so mapped landing pages
 *                   keep working card by card.
 */
export function buildCreativeParams(args: {
  pageId: string;
  instagramUserId?: string | null;
  content: CreativeContent;
  creative: CreativeInput;
}): Record<string, unknown> {
  const { pageId, instagramUserId, content, creative } = args;
  const useCta = !!creative.cta && creative.cta !== "NO_BUTTON";

  const objectStorySpec: Record<string, unknown> = { page_id: pageId };
  if (instagramUserId) objectStorySpec.instagram_user_id = instagramUserId;

  const name = `${creative.adName} — creative`;

  if (content.kind === "video") {
    if (!useCta) {
      throw new Error(
        "Video creatives need a call-to-action button to carry the destination link.",
      );
    }
    // >= 2 aspect slots → per-placement asset_feed_spec (identity-only story spec).
    if (content.videos.length >= 2) {
      return {
        name,
        object_story_spec: objectStorySpec,
        asset_feed_spec: buildVideoAssetFeedSpec(
          content.videos,
          content.thumbnailHash,
          creative,
        ),
      };
    }
    // Single video → the proven single-video creative shape.
    const only = content.videos[0]!;
    objectStorySpec.video_data = {
      video_id: only.videoId,
      image_hash: content.thumbnailHash,
      title: creative.headline,
      message: creative.primaryText,
      link_description: creative.subheadline,
      call_to_action: { type: creative.cta, value: { link: creative.link } },
    };
    return { name, object_story_spec: objectStorySpec };
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
    return { name, object_story_spec: objectStorySpec };
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
  return { name, object_story_spec: objectStorySpec };
}
