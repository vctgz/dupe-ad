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
// Scope: two engines, one write path.
//   Create    — from-scratch ad from freshly uploaded media (static image, video
//               with 1-3 aspect ratios, or carousel).
//   Duplicate — clones an EXISTING ad (found by exact name in each selected
//               campaign) onto that same store's Page, reusing its own
//               account-scoped assets as-is; only explicit copy/link/CTA
//               overrides change (see lib/meta/write.ts findSourceAdCreative /
//               buildDuplicateCreativeParams).
// Multi-placement asset_feed_spec for STATIC IMAGES in Create mode is still a
// follow-up (video already ships it; Duplicate carries over whatever format the
// source ad already has).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAccountBySlug } from "@/config/accounts";
import { resolveDiscoveryResult } from "@/lib/discovery/resolve";
import { loadLandingUrls } from "@/lib/mapping";
import { authorizeAccount } from "@/lib/route-guard";
import { LiveCredentialsError } from "@/lib/env";
import {
  MetaApiError,
  getMetaUsage,
  isRateLimitError,
  metaErrorToMessage,
  resolveToken,
} from "@/lib/meta/client";
import {
  base64FromDataUrl,
  buildCreativeParams,
  buildDuplicateCreativeParams,
  createCreativeAndPausedAd,
  fetchAdsetsByCampaign,
  findCampaignInstagramId,
  findSourceAdCreative,
  getVideoStatus,
  pickAdsetFromList,
  resolveTrackingPixelId,
  sourceHasVideo,
  sourceInstagramId,
  uploadImage,
  type CarouselCardSpec,
  type CreativeContent,
  type VideoPlacement,
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

const bodySchema = z
  .object({
    accountSlug: z.string().min(1),
    // Live writes currently support the from-scratch create flow only.
    mode: z.enum(["create", "duplicate"]).default("create"),
    // What the ad displays: a single image (default), a video, or a carousel.
    // Video ads carry 1-3 already-registered, already-READY account-scoped video ids
    // from /api/video (one per aspect slot) — raw video bytes never flow through this
    // route (serverless body limits). Carousel ads carry 2-10 cards, each with its image.
    format: z.enum(["single", "video", "carousel"]).default("single"),
    // One video id per uploaded aspect slot. 2+ slots build a per-placement
    // asset_feed_spec; a single slot keeps the proven single-video creative shape.
    videos: z
      .array(
        z.object({
          placement: z.enum(["square", "vertical", "horizontal"]),
          videoId: z.string().regex(/^\d{1,32}$/),
        }),
      )
      .min(1)
      .max(3)
      .optional(),
    // TODO(remove next release): legacy single-video field. A modal loaded before this
    // deploy still posts `videoId`; normalized to `videos: [{ placement: "square", … }]`
    // below so an in-flight session survives the rollout.
    videoId: z.string().regex(/^\d{1,32}$/).optional(),
    adName: z.string().min(1).max(512),
    // Duplicate mode only: the name for the CREATED ads. Blank/omitted keeps the
    // source ad's name — `adName` stays the finder either way.
    newAdName: z.string().trim().max(512).optional(),
    // Optional: target only ad sets whose name CONTAINS this (case-insensitive) in each
    // campaign. Omitted -> the campaign's active (else first) ad set.
    adsetName: z.string().trim().max(512).optional(),
    // Cap fan-out: bounds how many live writes a single request can trigger. Each
    // campaign is 2-3 serialized Graph calls, so 200 keeps a single run well-bounded.
    campaignIds: z.array(z.string().min(1).max(64)).min(1).max(200),
    // Create mode requires primaryText + link (enforced in superRefine, gated on
    // mode==="create"); Duplicate mode treats every field here as an OPTIONAL
    // override — blank means "keep the source ad's own value".
    creative: z.object({
      primaryText: z.string().max(2000).default(""),
      headline: z.string().max(255).default(""),
      subheadline: z.string().max(255).default(""),
      link: z.string().max(2048).default(""),
      cta: z.enum(CTA_TYPES).optional(),
    }),
    // Single: the ad image(s). Video: the REQUIRED thumbnail (square preferred).
    // Carousel: unused (cards carry the images).
    images: z
      .array(z.object({ placement: z.string().max(32).optional(), dataUrl: z.string().min(1) }))
      .max(5)
      .default([]),
    // Carousel cards, in display order. Per-card link is optional (falls back to the
    // per-store destination).
    cards: z
      .array(
        z.object({
          dataUrl: z.string().min(1),
          headline: z.string().min(1).max(255),
          description: z.string().max(255).optional(),
          link: z.string().max(2048).optional(),
        }),
      )
      .min(2)
      .max(10)
      .optional(),
  })
  .superRefine((val, ctx) => {
    // Each aspect slot may appear at most once — duplicate labels would collide in
    // asset_feed_spec's placement rules. Applies to BOTH modes (Create's own videos
    // and Duplicate's per-aspect overrides).
    const seenSlots = new Set<string>();
    for (const s of val.videos ?? []) {
      if (seenSlots.has(s.placement)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["videos"],
          message: `Duplicate video for the ${s.placement} slot.`,
        });
      }
      seenSlots.add(s.placement);
    }

    // Duplicate mode clones an already-valid creative and only patches explicit
    // overrides — none of Create's format/media requiredness applies. Only adName
    // (unconditionally required above) matters: it's the source ad to find.
    if (val.mode !== "create") return;

    if (val.format !== "carousel") {
      if (val.images.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["images"],
          message:
            val.format === "video" ? "A thumbnail image is required." : "An image is required.",
        });
      }
      for (const [field, label] of [
        ["headline", "A headline"],
        ["subheadline", "A subheadline"],
      ] as const) {
        if (val.creative[field].trim().length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["creative", field],
            message: `${label} is required.`,
          });
        }
      }
    }
    if (val.creative.primaryText.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["creative", "primaryText"],
        message: "Primary text is required.",
      });
    }
    if (val.creative.link.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["creative", "link"],
        message: "A destination URL is required.",
      });
    }
    if (val.format === "video") {
      // Accept the new `videos[]` or the legacy `videoId` (normalized later).
      const slots = val.videos ?? (val.videoId ? [{ placement: "square" as const, videoId: val.videoId }] : []);
      if (slots.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["videos"],
          message: "At least one registered video is required for video ads.",
        });
      }
      // video_data / asset_feed_spec has no top-level link field; the destination lives
      // only in the call_to_action, so "no button" cannot work for video.
      if (!val.creative.cta || val.creative.cta === "NO_BUTTON") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["creative", "cta"],
          message: "Video ads need a call-to-action button to carry the destination link.",
        });
      }
    }
    if (val.format === "carousel" && !val.cards) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cards"],
        message: "Carousel ads need 2-10 cards.",
      });
    }
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
  /** True when Meta's rate limit stopped the run early (after an in-run retry). */
  rateLimited?: boolean;
  /** Meta's estimate (minutes) until access returns, when rateLimited and known. */
  retryAfterMinutes?: number | null;
  /** Campaign ids not yet processed when timedOut/rateLimited — re-run just these. */
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

/** Human aspect label for a video slot, used in per-slot error messages. */
function ratioLabel(placement: VideoPlacement["placement"]): string {
  switch (placement) {
    case "square":
      return "square (1:1)";
    case "vertical":
      return "vertical (9:16)";
    case "horizontal":
      return "horizontal (16:9)";
  }
}

/**
 * Confirm EVERY submitted aspect slot finished processing BEFORE any store writes —
 * a not-ready video would fail every creative with an opaque Meta error. Returns the
 * error response to send, or null when all slots are ready. Shared by Create (the
 * ad's own videos) and Duplicate (per-aspect video overrides).
 */
async function verifyVideosReady(
  token: string,
  videos: VideoPlacement[],
): Promise<NextResponse<ApiError> | null> {
  for (const v of videos) {
    try {
      const status = await getVideoStatus(token, v.videoId);
      if (status.status !== "ready") {
        return NextResponse.json(
          {
            error:
              status.status === "error"
                ? `Meta could not process the ${ratioLabel(v.placement)} video — try uploading a different file.`
                : `The ${ratioLabel(v.placement)} video is still processing on Meta's side — try again in a moment.`,
          },
          { status: 409 },
        );
      }
    } catch (err) {
      const msg =
        err instanceof MetaApiError
          ? metaErrorToMessage(err)
          : err instanceof Error
            ? err.message
            : "Video check failed";
      return NextResponse.json(
        { error: `Could not verify the ${ratioLabel(v.placement)} video: ${msg}` },
        { status: 502 },
      );
    }
  }
  return null;
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

  const { accountSlug, mode, format, adName, campaignIds, creative, images, cards } =
    parsed.data;
  const adsetName = parsed.data.adsetName?.trim() || undefined;
  // The name every CREATED ad (and its creative) carries. Duplicate: an explicit
  // newAdName wins, else the clone keeps the source ad's name. Create: adName IS
  // the new ad's name.
  const createdAdName = (mode === "duplicate" && parsed.data.newAdName) || adName;
  // Normalize the video slots: prefer the new `videos[]`, else adapt the legacy
  // single `videoId` (a modal open across the deploy). superRefine already checked
  // presence + unique placements for video format.
  const videos: VideoPlacement[] =
    parsed.data.videos ??
    (parsed.data.videoId ? [{ placement: "square", videoId: parsed.data.videoId }] : []);

  const authz = authorizeAccount(accountSlug);
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }
  // Create requires a valid destination URL (superRefine already required it
  // non-blank). Duplicate treats it as an OPTIONAL override — validated only when
  // the operator actually typed one; blank means "keep the source ad's own link".
  if (mode === "create" && !isHttpUrl(creative.link)) {
    return NextResponse.json({ error: "A valid http(s) destination URL is required." }, { status: 400 });
  }
  if (mode === "duplicate" && creative.link.trim().length > 0 && !isHttpUrl(creative.link)) {
    return NextResponse.json(
      { error: "The destination URL override is not a valid http(s) URL." },
      { status: 400 },
    );
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
        ? metaErrorToMessage(err)
        : err instanceof Error
          ? err.message
          : "Could not load campaigns.";
    return NextResponse.json({ error: `Could not load campaigns: ${msg}` }, { status: 502 });
  }
  const byId = new Map<string, CampaignRow>();
  for (const r of discovery.rows) {
    if (r.campaignId) byId.set(r.campaignId, r);
  }

  // Account-wide Instagram identity fallback. A store's own row may not resolve an IG id
  // (its campaign's template ad had none), yet video asset_feed_spec creatives REQUIRE an
  // explicit instagram_user_id to serve on Instagram (error 100/1772103). Every store here
  // advertises as the same brand IG, so any campaign that DID resolve one gives the id to
  // reuse — no extra Graph calls, just the discovery data we already hold.
  const accountInstagramId = discovery.rows.find((r) => r.instagramUserId)?.instagramUserId ?? null;

  // Per-store landing pages from the mapping CSV's `url` column. When a store has
  // one, its ad links there; otherwise it falls back to the single Destination URL
  // from the modal (already validated as http(s) above).
  const landingUrls = await loadLandingUrls(account.slug);

  // Decode + upload the media this run needs — AFTER discovery so a discovery failure
  // never leaves orphan uploads. Hashes/ids are account-scoped: uploaded ONCE here and
  // reused across every store's page-bound creative. What each format needs:
  //   single   — one image;
  //   video    — the thumbnail image + a READY registered video;
  //   carousel — one image per card (2-10).
  // Duplicate mode uploads NOTHING here — each store's own source ad is resolved
  // fresh, per campaign, inside the write loop below (findSourceAdCreative).
  let content: CreativeContent | null = null;
  if (mode === "create") {
    if (format === "carousel") {
      const cardsIn = cards ?? [];
      const decoded: { base64: string; headline: string; description?: string; link?: string }[] =
        [];
      for (const [i, card] of cardsIn.entries()) {
        if (card.link && !isHttpUrl(card.link)) {
          return NextResponse.json(
            { error: `Card ${i + 1}: the link is not a valid http(s) URL.` },
            { status: 400 },
          );
        }
        const b64 = base64FromDataUrl(card.dataUrl);
        if (!b64) {
          return NextResponse.json(
            { error: `Card ${i + 1}: the image must be a base64 image data URL.` },
            { status: 400 },
          );
        }
        if (b64.length > 10_000_000) {
          return NextResponse.json(
            { error: `Card ${i + 1}: the image is too large (over ~7MB).` },
            { status: 413 },
          );
        }
        decoded.push({
          base64: b64,
          headline: card.headline,
          description: card.description,
          link: card.link,
        });
      }
      const cardSpecs: CarouselCardSpec[] = [];
      try {
        for (const d of decoded) {
          cardSpecs.push({
            imageHash: await uploadImage(account, token, d.base64),
            headline: d.headline,
            description: d.description,
            link: d.link,
          });
        }
      } catch (err) {
        const msg =
          err instanceof MetaApiError
            ? metaErrorToMessage(err)
            : err instanceof Error
              ? err.message
              : "Image upload failed";
        return NextResponse.json(
          { error: `Could not upload the image for card ${cardSpecs.length + 1}: ${msg}` },
          { status: 502 },
        );
      }
      content = { kind: "carousel", cards: cardSpecs };
    } else {
      // Pick one image (square preferred), decode it, and reject anything oversized.
      // For video ads this image is the REQUIRED thumbnail.
      const chosen = images.find((i) => i.placement === "square") ?? images[0]!;
      const base64 = base64FromDataUrl(chosen.dataUrl);
      if (!base64) {
        return NextResponse.json(
          { error: "Image must be a base64 image data URL." },
          { status: 400 },
        );
      }
      if (base64.length > 10_000_000) {
        return NextResponse.json({ error: "Image is too large (over ~7MB)." }, { status: 413 });
      }

      let imageHash: string;
      try {
        imageHash = await uploadImage(account, token, base64);
      } catch (err) {
        const msg =
          err instanceof MetaApiError
            ? metaErrorToMessage(err)
            : err instanceof Error
              ? err.message
              : "Image upload failed";
        return NextResponse.json({ error: `Could not upload the image: ${msg}` }, { status: 502 });
      }

      // Video: every uploaded aspect slot must be READY before any store writes.
      // (superRefine guarantees >= 1 slot with unique placements.) The thumbnail
      // (imageHash above) is shared across all slots.
      if (format === "video") {
        const notReady = await verifyVideosReady(token, videos);
        if (notReady) return notReady;
        content = { kind: "video", videos, thumbnailHash: imageHash };
      } else {
        content = { kind: "image", imageHash };
      }
    }
  } else if (videos.length > 0) {
    // Duplicate-mode video overrides: same READY guarantee before any store writes.
    // The slots themselves merge into each store's source creative per campaign,
    // inside the write loop (buildDuplicateCreativeParams handles the shapes).
    const notReady = await verifyVideosReady(token, videos);
    if (notReady) return notReady;
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
        ? metaErrorToMessage(err)
        : err instanceof Error
          ? err.message
          : "Could not load ad sets.";
    return NextResponse.json({ error: `Could not load ad sets: ${msg}` }, { status: 502 });
  }

  // SERIALIZE writes within the account (rate-limit safety, #8). Per-store results.
  // A wall-clock budget stops the loop before the function's maxDuration so we always
  // RETURN the results so far (with timedOut + remaining) instead of dying with no body —
  // the operator sees which stores succeeded and can re-run only the rest.
  //
  // Rate-limit posture: pace proactively once the usage headers show >= PACE_AT percent
  // utilization; on a rate-limit error retry the store ONCE after a short backoff; if Meta
  // still says no, STOP (rateLimited + remaining) instead of burning every remaining store
  // into the same wall — the modal offers a one-click resume.
  const wanted = [...new Set(campaignIds)];
  const results: CreateAdResultRow[] = [];
  const startedAt = Date.now();
  const BUDGET_MS = 50_000;
  const PACE_AT = 85; // utilization percent where writes start slowing down
  const RETRY_BACKOFF_MS = 5_000;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let timedOut = false;
  let rateLimited = false;
  let retryAfterMinutes: number | null = null;
  for (const campaignId of wanted) {
    if (Date.now() - startedAt > BUDGET_MS) {
      timedOut = true;
      break;
    }
    const row = byId.get(campaignId);
    const storeCode = row?.storeCode ?? null;
    const campaignName = row?.campaignName ?? "(unknown campaign)";
    // Captured once the params are built so the catch can dump EXACTLY what we POSTed
    // when a store fails — code 100 says nothing about which field was bad, the body does.
    let sentCreativeParams: Record<string, unknown> | null = null;
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
      // Per-store mapped landing page (mapping CSV `url` column) applies to BOTH
      // modes identically — it wins over whatever fallback/inherited link would
      // otherwise apply.
      const storeUrl = storeCode ? landingUrls.get(storeCode) ?? null : null;

      // Proactive pacing: when Meta's usage headers say we're near the wall, breathe
      // between stores (inside the budget) instead of slamming into error 17. Runs
      // before ANY further per-campaign Graph calls — duplicate mode's source-ad
      // lookup below included, not just the final write.
      const usage = getMetaUsage(account.id);
      if (usage && usage.utilizationPct >= PACE_AT) {
        const over = usage.utilizationPct - PACE_AT;
        await sleep(Math.min(5_000, 2_000 + over * 200));
        if (Date.now() - startedAt > BUDGET_MS) {
          timedOut = true;
          break;
        }
      }

      let creativeParams: Record<string, unknown>;
      if (mode === "duplicate") {
        // Duplicate: the mapped landing page (if any) still applies; otherwise an
        // operator-typed override; otherwise undefined — leave the source ad's own
        // link untouched (the "auto-carry-over" contract).
        const overrideLink = storeUrl ?? (creative.link.trim() || undefined);
        if (overrideLink && !isHttpUrl(overrideLink)) {
          results.push({
            campaignId, storeCode, campaignName, ok: false,
            error: "This store's mapped landing URL is not a valid http(s) URL.",
          });
          continue;
        }
        // Find THIS campaign's own ad named `adName` and read its creative fresh —
        // account-scoped assets (image_hash/video_id) it references are already
        // valid here, so nothing is re-uploaded.
        const found = await findSourceAdCreative(token, campaignId, adName);
        if (!found) {
          results.push({
            campaignId, storeCode, campaignName, ok: false,
            error: `No ad named "${adName}" found in this campaign.`,
          });
          continue;
        }
        creativeParams = buildDuplicateCreativeParams({
          pageId,
          // Store's own IG, else the exact source ad's own (same Page), else any IG an
          // ad in THIS campaign carries (multi-IG accounts: each store Page has its own
          // IG account, recorded only in its campaign's ad history), else the
          // account-wide brand IG — so a video clone always has an id to serve on
          // Instagram. The campaign lookup is one extra Graph read, spent only when a
          // video shape needs it and the cheaper sources came up empty.
          instagramUserId:
            row?.instagramUserId ??
            sourceInstagramId(found) ??
            (videos.length > 0 || sourceHasVideo(found)
              ? await findCampaignInstagramId(token, campaignId)
              : null) ??
            accountInstagramId,
          source: found,
          overrides: {
            adName: createdAdName,
            primaryText: creative.primaryText.trim() || undefined,
            headline: creative.headline.trim() || undefined,
            subheadline: creative.subheadline.trim() || undefined,
            link: overrideLink,
            cta: creative.cta,
          },
          // Per-aspect video replacements (already verified READY above); empty
          // keeps every ratio from this store's own source ad.
          videoOverrides: videos.length > 0 ? videos : undefined,
        });
      } else {
        // Create: this store's landing page wins over the modal's fallback URL. A
        // mapped URL that isn't http(s) fails just this store, with a clear message,
        // rather than silently sending its ad to the fallback.
        const link = storeUrl ?? creative.link;
        if (!isHttpUrl(link)) {
          results.push({
            campaignId, storeCode, campaignName, ok: false,
            error: "This store's mapped landing URL is not a valid http(s) URL.",
          });
          continue;
        }
        creativeParams = buildCreativeParams({
          pageId,
          // A fresh video ad must carry an IG id to serve on Instagram. When this
          // store's row didn't resolve one (an account with no Template-named ads
          // resolves none, ever), read it from the campaign's OWN existing ads first —
          // on multi-IG accounts the account-wide id is another store's identity, so
          // it stays the last resort.
          instagramUserId:
            row?.instagramUserId ??
            (format === "video" ? await findCampaignInstagramId(token, campaignId) : null) ??
            accountInstagramId,
          content: content!,
          creative: { adName, ...creative, link },
        });
      }

      sentCreativeParams = creativeParams;

      // One batched round trip per store: creative + PAUSED ad as dependent Graph
      // batch ops (both still count individually toward rate limits).
      const writeOne = (): Promise<string> =>
        createCreativeAndPausedAd(account, token, {
          adName: createdAdName,
          creativeParams,
          adsetId,
          pixelId,
        });

      let adId: string;
      try {
        adId = await writeOne();
      } catch (err) {
        // Retry ONCE on a rate limit, if the budget still has room for backoff + a
        // creative/ad pair. (If the creative was made but the ad call was throttled,
        // the retry makes a fresh creative; the unattached one is inert and harmless.)
        const budgetLeft = BUDGET_MS - (Date.now() - startedAt);
        if (!isRateLimitError(err) || budgetLeft < RETRY_BACKOFF_MS + 10_000) throw err;
        await sleep(RETRY_BACKOFF_MS);
        adId = await writeOne();
      }
      results.push({ campaignId, storeCode, campaignName, ok: true, adId, pageId });
    } catch (err) {
      if (isRateLimitError(err)) {
        // Still throttled after the retry (or no budget to retry): suspend the run.
        // This store gets no result row, so it lands in `remaining` for the resume.
        rateLimited = true;
        retryAfterMinutes = err.retryAfterMinutes;
        // eslint-disable-next-line no-console
        console.warn(
          `[create] ${account.slug} rate limited at campaign ${campaignId}; suspending run ` +
            `(retryAfter=${retryAfterMinutes ?? "?"}min)`,
        );
        break;
      }
      const msg =
        err instanceof MetaApiError
          ? metaErrorToMessage(err)
          : err instanceof Error
            ? err.message
            : "Create failed";
      // eslint-disable-next-line no-console
      console.error(
        `[create] ${account.slug} campaign ${campaignId} failed: ${msg}` +
          (err instanceof MetaApiError && err.fbtraceId ? ` [fbtrace ${err.fbtraceId}]` : ""),
      );
      // On a Meta rejection, record the exact body we sent (size-capped) — this is the
      // difference between "code 100 somewhere" and seeing the offending param verbatim.
      if (err instanceof MetaApiError && sentCreativeParams) {
        const dump = JSON.stringify(sentCreativeParams);
        const capped =
          dump.length > 8000 ? `${dump.slice(0, 8000)}…(+${dump.length - 8000} more chars)` : dump;
        // eslint-disable-next-line no-console
        console.error(`[create] ${account.slug} campaign ${campaignId} creativeParams=${capped}`);
      }
      results.push({ campaignId, storeCode, campaignName, ok: false, error: msg });
    }
  }

  const created = results.filter((r) => r.ok).length;
  const processed = new Set(results.map((r) => r.campaignId));
  const stopped = timedOut || rateLimited;
  return NextResponse.json({
    count: results.length,
    created,
    failed: results.length - created,
    results,
    timedOut,
    rateLimited,
    retryAfterMinutes,
    remaining: stopped ? wanted.filter((id) => !processed.has(id)) : [],
  });
}
