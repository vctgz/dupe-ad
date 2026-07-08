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
 * object_story_spec, asset_feed_spec? }`. Used by the Create flow (fresh media);
 * Duplicate mode uses buildDuplicateCreativeParams() below instead.
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

// ── Duplicate mode: clone an EXISTING ad's creative onto another store ──────────
//
// Unlike Create (fresh media, freshly built params), Duplicate starts from a source
// ad already living in this same account — its image_hash(es)/video_id(s) are
// already valid here, so nothing is re-uploaded. We deep-clone its own creative
// shape and patch only what the operator explicitly overrides; a multi-aspect
// `asset_feed_spec` (e.g. our own 1-3 ratio video ads) carries its assets +
// placement rules over UNCHANGED, so an already-serving multi-ratio ad keeps
// serving every ratio per placement when cloned onto another store's Page.

/** Deep-clone a plain JSON-shaped value (Graph API responses are always JSON-safe). */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A source ad's creative, as read fresh from Meta for DUPLICATE mode. */
export interface DuplicateSourceCreative {
  objectStorySpec: Record<string, unknown> | null;
  assetFeedSpec: Record<string, unknown> | null;
}

/**
 * What the operator may override when duplicating an ad. Every field besides
 * `adName` is OPTIONAL — undefined/blank means "keep the source ad's own value".
 * This is the "auto-carry-over" contract: duplicate clones an already-valid
 * creative (any format) and only touches what's explicitly typed.
 */
export interface DuplicateOverrides {
  adName: string;
  primaryText?: string;
  headline?: string;
  subheadline?: string;
  link?: string;
  cta?: string;
}

/** Reverse of VIDEO_LABELS: our adlabel name → its aspect slot. */
const PLACEMENT_BY_LABEL: Record<string, VideoPlacementKey> = Object.fromEntries(
  (Object.entries(VIDEO_LABELS) as [VideoPlacementKey, string][]).map(([k, v]) => [v, k]),
);

/** The slot our adlabel scheme assigns this videos[] entry, or null if foreign. */
function slotOfEntry(entry: Record<string, unknown>): VideoPlacementKey | null {
  const labels = entry.adlabels as { name?: string }[] | undefined;
  if (!Array.isArray(labels)) return null;
  for (const l of labels) {
    const slot = l?.name ? PLACEMENT_BY_LABEL[l.name] : undefined;
    if (slot) return slot;
  }
  return null;
}

/** The thumbnail fields (`thumbnail_hash`/`thumbnail_url`) reusable from an entry. */
function thumbOfEntry(entry: Record<string, unknown>): Record<string, unknown> | null {
  if (entry.thumbnail_hash) return { thumbnail_hash: entry.thumbnail_hash };
  if (entry.thumbnail_url) return { thumbnail_url: entry.thumbnail_url };
  return null;
}

/**
 * Apply per-aspect VIDEO replacements to a source creative before cloning it.
 * The operator's contract: an empty slot keeps the source ad's video for that
 * placement; a filled slot swaps in the newly registered (account-scoped) video.
 *
 * How the merge lands depends on the source's shape:
 *   ours (asset_feed_spec, our VID_* labels)  — swap matching slots' video_id in
 *     place; APPEND new slots (reusing the source thumbnail) and rebuild the
 *     placement rules from the merged slot set (only when the set grew).
 *   foreign asset_feed_spec — no way to know which entry is which ratio: ONE
 *     override replaces every entry's video (labels/rules untouched); 2+ replace
 *     the whole video set with our labeled slots + our rules.
 *   single video_data — one override swaps the video in place; 2+ rebuild the
 *     creative as a fresh multi-ratio asset_feed_spec from the source's own
 *     copy/CTA/thumbnail.
 *   not a video ad — throws (surfaced as that store's per-row error).
 */
function applyVideoOverrides(
  source: DuplicateSourceCreative,
  overrides: VideoPlacement[],
): DuplicateSourceCreative {
  if (source.assetFeedSpec) {
    const afs = cloneJson(source.assetFeedSpec);
    const entries = Array.isArray(afs.videos)
      ? (afs.videos as Record<string, unknown>[])
      : null;
    if (!entries || entries.length === 0) {
      throw new Error(
        "The source ad's creative carries no videos to replace — it may be an image ad.",
      );
    }

    const allOurs = entries.every((e) => slotOfEntry(e) !== null);
    if (allOurs) {
      const byPlacement = new Map<VideoPlacementKey, Record<string, unknown>>();
      for (const e of entries) byPlacement.set(slotOfEntry(e)!, e);
      let grew = false;
      for (const o of overrides) {
        const existing = byPlacement.get(o.placement);
        if (existing) {
          existing.video_id = o.videoId;
          continue;
        }
        const thumb = thumbOfEntry(entries[0]!);
        if (!thumb) {
          throw new Error(
            "The source ad has no reusable thumbnail for the newly added ratio.",
          );
        }
        const added: Record<string, unknown> = {
          video_id: o.videoId,
          ...thumb,
          adlabels: [{ name: VIDEO_LABELS[o.placement] }],
        };
        entries.push(added);
        byPlacement.set(o.placement, added);
        grew = true;
      }
      // A pure swap keeps the source's own (already-valid) rules; a grown slot set
      // needs rules covering the new ratio's placements.
      if (grew) {
        afs.asset_customization_rules = buildVideoAssetRules(new Set(byPlacement.keys()));
      }
    } else if (overrides.length === 1) {
      // Foreign labels, one new video: serve it everywhere the old ones did.
      for (const e of entries) e.video_id = overrides[0]!.videoId;
    } else {
      // Foreign labels, full replacement: our labeled slots + our placement rules.
      const thumb = thumbOfEntry(entries[0]!);
      if (!thumb) {
        throw new Error("The source ad has no reusable thumbnail for the replacement videos.");
      }
      afs.videos = overrides.map((o) => ({
        video_id: o.videoId,
        ...thumb,
        adlabels: [{ name: VIDEO_LABELS[o.placement] }],
      }));
      afs.ad_formats = ["SINGLE_VIDEO"];
      afs.optimization_type = "PLACEMENT";
      afs.asset_customization_rules = buildVideoAssetRules(
        new Set(overrides.map((o) => o.placement)),
      );
    }
    return { objectStorySpec: source.objectStorySpec, assetFeedSpec: afs };
  }

  const vd = source.objectStorySpec?.video_data as Record<string, unknown> | undefined;
  if (vd) {
    if (overrides.length === 1) {
      const oss = cloneJson(source.objectStorySpec!);
      (oss.video_data as Record<string, unknown>).video_id = overrides[0]!.videoId;
      return { objectStorySpec: oss, assetFeedSpec: null };
    }
    // 2+ ratios on a single-video source: rebuild as a multi-ratio asset_feed_spec
    // from the source's own copy, CTA, and thumbnail.
    const cta = vd.call_to_action as
      | { type?: unknown; value?: { link?: unknown } }
      | undefined;
    if (!cta?.type || !cta.value?.link) {
      throw new Error(
        "The source video ad has no call-to-action link to carry — can't rebuild it multi-ratio.",
      );
    }
    const thumb = vd.image_hash
      ? { thumbnail_hash: vd.image_hash }
      : vd.image_url
        ? { thumbnail_url: vd.image_url }
        : null;
    if (!thumb) {
      throw new Error("The source video ad has no thumbnail to reuse for the new ratios.");
    }
    const afs: Record<string, unknown> = {
      ad_formats: ["SINGLE_VIDEO"],
      optimization_type: "PLACEMENT",
      videos: overrides.map((o) => ({
        video_id: o.videoId,
        ...thumb,
        adlabels: [{ name: VIDEO_LABELS[o.placement] }],
      })),
      bodies: [{ text: vd.message ?? "" }],
      titles: [{ text: vd.title ?? "" }],
      descriptions: [{ text: vd.link_description ?? "" }],
      link_urls: [{ website_url: cta.value.link }],
      call_to_action_types: [cta.type],
      asset_customization_rules: buildVideoAssetRules(
        new Set(overrides.map((o) => o.placement)),
      ),
    };
    return { objectStorySpec: source.objectStorySpec, assetFeedSpec: afs };
  }

  throw new Error(
    "The source ad isn't a video ad — clear the video overrides or duplicate a video ad name.",
  );
}

// ── Read-back → write-safe sanitizers ───────────────────────────────────────────
//
// Graph's creative READ representation (what findSourceAdCreative pulls) is NOT a valid
// write body: it carries output-only fields the write endpoint rejects with a generic
// `error 100 (Invalid parameter)`. Before POSTing a cloned spec we re-project it through
// a fixed whitelist so only write-accepted params survive. These run on the VIDEO shapes
// (asset_feed_spec with videos[], and single video_data) — the image/carousel link_data
// clone path is left untouched (it is already proven live and mostly input-shaped).

/** Read-back adlabels are `[{id,name,created_time}]`; a write needs only `[{name}]`. */
function cleanLabelNames(labels: unknown): { name: string }[] | undefined {
  if (!Array.isArray(labels)) return undefined;
  const out: { name: string }[] = [];
  for (const l of labels) {
    const name = l && typeof l === "object" ? (l as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name.length > 0) out.push({ name });
  }
  return out.length > 0 ? out : undefined;
}

/** Keep only a videos[] entry's write-safe keys: the id, ONE thumbnail (the stable hash
 *  preferred over a signed/expiring url), and name-only adlabels. */
function cleanVideoEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (entry.video_id !== undefined) out.video_id = entry.video_id;
  if (entry.thumbnail_hash !== undefined) out.thumbnail_hash = entry.thumbnail_hash;
  else if (entry.thumbnail_url !== undefined) out.thumbnail_url = entry.thumbnail_url;
  const labels = cleanLabelNames(entry.adlabels);
  if (labels) out.adlabels = labels;
  return out;
}

/** Copy assets (bodies/titles/descriptions) read back with a per-asset `id`; a write needs
 *  only `{text}`. Meta rejects `{text:""}`, so blank entries are dropped and an all-blank
 *  array is omitted entirely (returns undefined) rather than sent. */
function cleanTextAssets(arr: unknown): { text: string }[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  const out: { text: string }[] = [];
  for (const a of arr) {
    const text = a && typeof a === "object" ? (a as { text?: unknown }).text : undefined;
    if (typeof text === "string" && text.trim().length > 0) out.push({ text });
  }
  return out.length > 0 ? out : undefined;
}

/** link_urls read back with a per-asset `id`; a write needs only `{website_url}`. */
function cleanLinkUrls(arr: unknown): { website_url: string }[] | undefined {
  if (!Array.isArray(arr)) return undefined;
  const out: { website_url: string }[] = [];
  for (const a of arr) {
    const url =
      a && typeof a === "object" ? (a as { website_url?: unknown }).website_url : undefined;
    if (typeof url === "string" && url.trim().length > 0) out.push({ website_url: url });
  }
  return out.length > 0 ? out : undefined;
}

/** Placement/platform keys a customization_spec may carry into a write. Read-back also
 *  expands it with demographic defaults (age_min/age_max/genders/…) that don't belong. */
const PLACEMENT_SPEC_KEYS = new Set([
  "publisher_platforms",
  "facebook_positions",
  "instagram_positions",
  "audience_network_positions",
  "messenger_positions",
  "threads_positions",
]);

/** Re-project one asset_customization_rule: placement-only customization_spec, name-only
 *  label (video_label reads back as `{id,name,created_time}`), and priority. */
function cleanRule(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const spec = rule.customization_spec;
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    const cleanSpec: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spec as Record<string, unknown>)) {
      if (PLACEMENT_SPEC_KEYS.has(k)) cleanSpec[k] = v;
    }
    out.customization_spec = cleanSpec;
  }
  // Preserve whichever *_label the rule keys on (video_label for our feeds), name-only.
  for (const [k, v] of Object.entries(rule)) {
    if (k.endsWith("_label")) {
      const name = v && typeof v === "object" ? (v as { name?: unknown }).name : undefined;
      if (typeof name === "string" && name.length > 0) out[k] = { name };
    }
  }
  if (typeof rule.priority === "number") out.priority = rule.priority;
  return out;
}

/**
 * Rebuild a cloned VIDEO `asset_feed_spec` from a fixed whitelist so no read-back
 * output-only field survives into the write. Only video-bearing specs reach here
 * (videos[] present); copy/link arrays that come out empty are omitted, not sent as
 * `[{text:""}]`. Non-video (image) asset feeds are never passed here.
 */
function sanitizeVideoAssetFeedSpec(afs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (afs.ad_formats !== undefined) out.ad_formats = afs.ad_formats;
  if (afs.optimization_type !== undefined) out.optimization_type = afs.optimization_type;
  out.videos = (afs.videos as Record<string, unknown>[]).map(cleanVideoEntry);
  const bodies = cleanTextAssets(afs.bodies);
  if (bodies) out.bodies = bodies;
  const titles = cleanTextAssets(afs.titles);
  if (titles) out.titles = titles;
  const descriptions = cleanTextAssets(afs.descriptions);
  if (descriptions) out.descriptions = descriptions;
  const linkUrls = cleanLinkUrls(afs.link_urls);
  if (linkUrls) out.link_urls = linkUrls;
  if (Array.isArray(afs.call_to_action_types) && afs.call_to_action_types.length > 0) {
    out.call_to_action_types = afs.call_to_action_types;
  }
  if (Array.isArray(afs.asset_customization_rules)) {
    out.asset_customization_rules = (
      afs.asset_customization_rules as Record<string, unknown>[]
    ).map(cleanRule);
  }
  return out;
}

/** Whitelisted keys of a single-video `video_data` write body. */
const VIDEO_DATA_KEYS = [
  "video_id",
  "image_hash",
  "image_url",
  "title",
  "message",
  "link_description",
  "call_to_action",
] as const;

/**
 * Whitelist a cloned single-video `video_data` down to write-safe params. Prefers the
 * stable `image_hash` thumbnail; keeps the signed/expiring `image_url` only when no hash
 * is present. Drops every read-back output-only field.
 */
function sanitizeVideoData(vd: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of VIDEO_DATA_KEYS) {
    if (k === "image_url" && vd.image_hash !== undefined) continue; // hash wins
    if (vd[k] !== undefined) out[k] = vd[k];
  }
  return out;
}

/**
 * The source ad's OWN Instagram identity — modern `instagram_user_id`, or the legacy
 * `instagram_actor_id` — read from its object_story_spec. Used as a fallback when the
 * destination store didn't resolve an IG id of its own: the clone lands on the SAME Page
 * as the source, so the source ad's IG account is the faithful identity to advertise as.
 * Load-bearing for video `asset_feed_spec`, which Meta won't serve on Instagram without an
 * explicit id (it does NOT auto-apply Page representation — error 100/1772103).
 */
export function sourceInstagramId(source: DuplicateSourceCreative): string | null {
  const oss = source.objectStorySpec;
  if (!oss) return null;
  const id = oss.instagram_user_id ?? oss.instagram_actor_id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Build fresh `POST .../adcreatives` params for DUPLICATE mode. Starts from a deep
 * clone of the SOURCE ad's own creative, rebinds the page to the DESTINATION store's, and
 * patches in only the copy/link/CTA fields — and per-aspect video slots (`videoOverrides`)
 * — the operator explicitly overrode.
 *
 * Instagram identity resolves with a fallback chain: the caller's `instagramUserId` (the
 * store's own, freshly resolved) wins; otherwise the SOURCE ad's own IG id is carried over
 * (same Page, and required for video to serve on Instagram) rather than dropped.
 */
export function buildDuplicateCreativeParams(args: {
  pageId: string;
  instagramUserId?: string | null;
  source: DuplicateSourceCreative;
  overrides: DuplicateOverrides;
  /** Per-aspect video replacements; empty/omitted keeps the source ad's videos. */
  videoOverrides?: VideoPlacement[];
}): Record<string, unknown> {
  const { pageId, instagramUserId, overrides } = args;
  const name = `${overrides.adName} — creative`;

  if (!args.source.objectStorySpec && !args.source.assetFeedSpec) {
    throw new Error("The source ad has no readable creative to duplicate.");
  }

  // Prefer the store's own resolved IG identity; else keep the source ad's own (the clone
  // is on the same Page, so it's valid — and video creatives need an explicit id to serve
  // on Instagram). null only when neither exists.
  const igId = instagramUserId ?? sourceInstagramId(args.source);

  const source =
    args.videoOverrides && args.videoOverrides.length > 0
      ? applyVideoOverrides(args.source, args.videoOverrides)
      : args.source;

  // Multi-aspect source (today: our own 1-3 ratio video ads) — reuse the labeled
  // asset array + placement rules VERBATIM (account-scoped ids are already valid
  // here); only the copy/link/CTA arrays get rewritten.
  if (source.assetFeedSpec) {
    const afs = cloneJson(source.assetFeedSpec);
    if (overrides.primaryText) afs.bodies = [{ text: overrides.primaryText }];
    if (overrides.headline) afs.titles = [{ text: overrides.headline }];
    if (overrides.subheadline) afs.descriptions = [{ text: overrides.subheadline }];
    if (overrides.link) afs.link_urls = [{ website_url: overrides.link }];
    if (overrides.cta) afs.call_to_action_types = [overrides.cta];
    const identity: Record<string, unknown> = { page_id: pageId };
    if (igId) identity.instagram_user_id = igId;
    // Read-back JSON isn't a valid write body — strip output-only contamination (asset
    // ids, adlabels/video_label id+created_time, age-expanded customization_spec, signed
    // thumbnail urls) from any VIDEO spec before POSTing. Image asset feeds (no videos[])
    // pass through unchanged.
    const cleaned =
      Array.isArray(afs.videos) && (afs.videos as unknown[]).length > 0
        ? sanitizeVideoAssetFeedSpec(afs)
        : afs;
    return { name, object_story_spec: identity, asset_feed_spec: cleaned };
  }

  const oss = cloneJson(source.objectStorySpec!);
  // Rebind the Page to the destination; set the resolved IG id (store's own, else the
  // source's own carried over). Drop the legacy instagram_actor_id so we never emit both.
  oss.page_id = pageId;
  delete oss.instagram_actor_id;
  if (igId) oss.instagram_user_id = igId;
  else delete oss.instagram_user_id;

  if (oss.video_data) {
    const vd = oss.video_data as Record<string, unknown>;
    if (overrides.headline) vd.title = overrides.headline;
    if (overrides.primaryText) vd.message = overrides.primaryText;
    if (overrides.subheadline) vd.link_description = overrides.subheadline;
    if (overrides.link || overrides.cta) {
      const prevCta = (vd.call_to_action as Record<string, unknown>) ?? {};
      const prevValue = (prevCta.value as Record<string, unknown>) ?? {};
      vd.call_to_action = {
        type: overrides.cta ?? prevCta.type,
        value: { ...prevValue, link: overrides.link ?? prevValue.link },
      };
    }
    // Whitelist the cloned video_data down to write-safe params (read-back adds
    // output-only fields; prefer image_hash over the signed image_url thumbnail).
    oss.video_data = sanitizeVideoData(vd);
  } else if (oss.link_data) {
    const ld = oss.link_data as Record<string, unknown>;
    if (overrides.primaryText) ld.message = overrides.primaryText;
    // Carousel cards carry their own name/description/link/CTA — leave them alone;
    // duplicate mode has no per-card override UI. Single-image name/description map
    // to headline/subheadline.
    if (!ld.child_attachments) {
      if (overrides.headline) ld.name = overrides.headline;
      if (overrides.subheadline) ld.description = overrides.subheadline;
    }
    if (overrides.link) {
      ld.link = overrides.link;
      if (ld.call_to_action) {
        const cta = ld.call_to_action as Record<string, unknown>;
        cta.value = { ...(cta.value as Record<string, unknown>), link: overrides.link };
      }
    }
    if (overrides.cta) {
      ld.call_to_action = { type: overrides.cta, value: { link: overrides.link ?? (ld.link as string) } };
    }
  }

  return { name, object_story_spec: oss };
}
