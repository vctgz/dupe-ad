// POST /api/duplicate/preview
// DRY-RUN duplication planner. NO WRITES of any kind. It READS campaigns from the same
// source the discovery table uses (a live Meta read in production), then for each selected
// campaignId emits a plan row describing where a duplicated/new ad WOULD land (the store's
// own resolved Page) and whether that target is ready.
//
// This is the read-only seam in front of the live write engine: the modal previews the
// plan; nothing is created here.
//
// Auth-protected exactly like the other JSON APIs (reuses the route guard).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAccountBySlug } from "@/config/accounts";
import { resolveDiscoveryResult } from "@/lib/discovery/resolve";
import { hasLiveCredentials, LiveCredentialsError } from "@/lib/env";
import { MetaApiError, metaErrorToMessage, resolveToken } from "@/lib/meta/client";
import { fetchAdsetsByCampaign, pickAdsetFromList } from "@/lib/meta/write";
import { authorizeAccount } from "@/lib/route-guard";
import type { ApiError } from "@/lib/types";
import type { CampaignRow, DiscoveryResult } from "@/lib/discovery/types";

export const dynamic = "force-dynamic";
// Live discovery (in live mode) can fan out across paginated Meta calls; give headroom.
export const maxDuration = 60;

// The two ad-creator modes the dry run plans for:
//   duplicate - clone an existing ad (by name) onto each store's own live Page.
//   create    - build a brand-new ad on each store's mapped/live Page.
export type DuplicateMode = "duplicate" | "create";

// Client-supplied creative — accepted but NOT used to write anything here. It is
// validated for shape so the live engine inherits a clean contract; the preview
// only echoes intent. `subheadline` maps to link_data.description.
const creativeSchema = z.object({
  primaryText: z.string().default(""),
  headline: z.string().default(""),
  subheadline: z.string().default(""),
  link: z.string().optional(),
  cta: z.string().optional(),
});

const bodySchema = z.object({
  accountSlug: z.string().min(1),
  campaignIds: z.array(z.string().min(1).max(64)).max(200).default([]),
  mode: z.enum(["duplicate", "create"]).default("duplicate"),
  /** Required in duplicate mode — the exact ad name to clone from each campaign. */
  adName: z.string().optional(),
  /** Optional: target only ad sets whose name contains this in each campaign. */
  adsetName: z.string().trim().max(512).optional(),
  /** Destination URL — required in create mode, optional in duplicate mode. */
  link: z.string().optional(),
  creative: creativeSchema,
});

/** Template ad name we can verify against the snapshot (case-insensitive). */
const TEMPLATE_AD_NAME = "Template";

/**
 * Whether the snapshot can confirm an ad named `adName` exists for a campaign.
 *   true        - the row has a Template ad AND adName == "Template" (verifiable).
 *   "unverified"- can't be confirmed from the snapshot; checked at create time.
 */
export type NameMatch = boolean | "unverified";

/** One per-store plan row the modal renders. */
export interface DuplicatePlanRow {
  campaignId: string;
  campaignName: string;
  storeCode: string | null;
  /** The Page a duplicated/new ad WOULD be created on (the live/actual page). */
  targetPage: string | null;
  /** The Page the mapping CSV says this store should publish from. */
  mappedPage: string | null;
  /** Whether the live page matches the mapping (informational, not blocking). */
  pageMatches: boolean;
  hasTemplateAd: boolean;
  /**
   * Duplicate mode only: whether an ad named `adName` is known to exist.
   * null in create mode (no source ad to clone).
   */
  nameMatch: NameMatch | null;
  /** Duplicate mode only: human note about name verification. */
  nameNote: string | null;
  /** The targeted ad set name (echoed), or null when none was specified. */
  adsetName: string | null;
  /**
   * Whether the campaign has an ad set matching `adsetName`: true/false when verified
   * live, "unverified" when it couldn't be checked, null when no name was specified.
   */
  adsetMatch: boolean | "unverified" | null;
  /** Ready only when a target Page resolved (+ a link in create mode). */
  ready: boolean;
  /** Human reason a row is not ready (null when ready). */
  blockReason: string | null;
}

export interface DuplicatePreviewResponse {
  mode: DuplicateMode;
  count: number;
  /** Distinct store codes across the ready+blocked set. */
  stores: number;
  ready: number;
  blocked: number;
  rows: DuplicatePlanRow[];
}

function planRow(
  row: CampaignRow,
  mode: DuplicateMode,
  adName: string,
  link: string,
  adsetName: string | null,
  adsetMatch: boolean | "unverified" | null,
): DuplicatePlanRow {
  // create mode targets the store's mapped/live Page; duplicate mode targets the
  // live (actual) Page it would clone the source ad onto.
  const targetPage = mode === "create" ? (row.mappedPage ?? row.actualPage) : row.actualPage;
  const hasPage = Boolean(targetPage);
  const pageMatches =
    !!row.actualPage && !!row.mappedPage && row.actualPage === row.mappedPage;

  let nameMatch: NameMatch | null = null;
  let nameNote: string | null = null;
  if (mode === "duplicate") {
    if (row.hasTemplateAd && adName.trim().toLowerCase() === TEMPLATE_AD_NAME.toLowerCase()) {
      nameMatch = true;
      nameNote = `An ad named "${adName}" was found in the latest discovery.`;
    } else {
      nameMatch = "unverified";
      nameNote = `Can't verify "${adName}" from the snapshot — it'll be confirmed at create time.`;
    }
  }

  // Readiness: a resolved Page always required; create mode also needs a link; and when an
  // ad set name was targeted, the campaign must actually have it (false blocks; an
  // "unverified" match does NOT block — it's confirmed at create time).
  const adsetOk = adsetMatch !== false;
  const ready = adsetOk && (mode === "create" ? hasPage && link.trim().length > 0 : hasPage);

  let blockReason: string | null = null;
  if (!ready) {
    if (!adsetOk) {
      blockReason = adsetName
        ? `No ad set matching "${adsetName}" in this campaign.`
        : "No ad set found for this campaign.";
    } else if (!hasPage) {
      blockReason =
        row.mappedPage != null
          ? "No live Page resolved from Meta for this campaign (mapping has one, the API returned none)."
          : mode === "create"
            ? "No Page could be resolved for this store — nothing to create the ad on."
            : "No Page could be resolved for this campaign — nothing to duplicate onto.";
    } else {
      // create mode, page ok but link missing.
      blockReason = "A destination URL is required to create a new ad.";
    }
  }

  return {
    campaignId: row.campaignId as string,
    // Reconcile-mode rows always carry a name; coalesce only to satisfy the
    // (now-nullable) shared CampaignRow type. Store-list rows never reach here.
    campaignName: row.campaignName ?? "(unnamed campaign)",
    storeCode: row.storeCode,
    targetPage,
    mappedPage: row.mappedPage,
    pageMatches,
    hasTemplateAd: row.hasTemplateAd,
    nameMatch,
    nameNote,
    adsetName,
    adsetMatch,
    ready,
    blockReason,
  };
}

export async function POST(
  req: NextRequest,
): Promise<NextResponse<DuplicatePreviewResponse | ApiError>> {
  // Reject oversized bodies before buffering (campaignIds + small creative only).
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > 256_000) {
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

  const { accountSlug, campaignIds, mode } = parsed.data;
  const adName = (parsed.data.adName ?? "").trim();
  const link = (parsed.data.link ?? "").trim();
  const adsetName = parsed.data.adsetName?.trim() || null;

  const authz = authorizeAccount(accountSlug);
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }

  const account = getAccountBySlug(accountSlug);
  if (!account) {
    return NextResponse.json({ error: `Unknown account "${accountSlug}"` }, { status: 400 });
  }

  if (campaignIds.length === 0) {
    return NextResponse.json({ error: "No campaigns selected" }, { status: 400 });
  }

  // Mode-specific required inputs.
  if (mode === "duplicate" && adName.length === 0) {
    return NextResponse.json(
      { error: "An ad name to duplicate is required in duplicate mode." },
      { status: 400 },
    );
  }
  if (mode === "create" && link.length === 0) {
    return NextResponse.json(
      { error: "A destination URL is required in create mode." },
      { status: 400 },
    );
  }

  // Resolve the SAME source the discovery table reads. Pinned to "live" when creds exist
  // so a DISCOVERY_SOURCE of "mapping"/"snapshot" can't hand back store-list rows
  // (campaignId: null) that would make every selected campaign look "not found". This is a
  // DRY RUN — it READS campaigns to build the plan but performs NO writes of any kind.
  let discovery: DiscoveryResult;
  try {
    discovery = await resolveDiscoveryResult(
      account,
      hasLiveCredentials(account.tokenEnvVar) ? "live" : undefined,
    );
  } catch (err) {
    if (err instanceof LiveCredentialsError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
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

  const wanted = new Set(campaignIds);

  // When a specific ad set name is targeted, verify it per campaign (one account-level
  // ad-sets pull) so the plan flags campaigns that lack it. Needs live creds; otherwise the
  // match stays "unverified" (confirmed at create time). Best-effort: a fetch failure also
  // leaves it unverified rather than blocking the whole preview.
  let adsetMatchByCampaign: Map<string, boolean> | null = null;
  if (adsetName && hasLiveCredentials(account.tokenEnvVar)) {
    try {
      const adsetsByCampaign = await fetchAdsetsByCampaign(resolveToken(account), account.id);
      adsetMatchByCampaign = new Map();
      for (const id of wanted) {
        const found = pickAdsetFromList(adsetsByCampaign.get(id) ?? [], adsetName).id !== null;
        adsetMatchByCampaign.set(id, found);
      }
    } catch {
      adsetMatchByCampaign = null;
    }
  }

  const rows: DuplicatePlanRow[] = [];
  for (const id of wanted) {
    const row = byId.get(id);
    const adsetMatch: boolean | "unverified" | null = adsetName
      ? adsetMatchByCampaign
        ? adsetMatchByCampaign.get(id) ?? false
        : "unverified"
      : null;
    if (!row) {
      // Selected id no longer present in the snapshot — surface as a blocked row.
      rows.push({
        campaignId: id,
        campaignName: "(not found in latest discovery)",
        storeCode: null,
        targetPage: null,
        mappedPage: null,
        pageMatches: false,
        hasTemplateAd: false,
        nameMatch: mode === "duplicate" ? "unverified" : null,
        nameNote: null,
        adsetName: null,
        adsetMatch: null,
        ready: false,
        blockReason: "Campaign not found in the latest discovery — re-scan.",
      });
      continue;
    }
    rows.push(planRow(row, mode, adName, link, adsetName, adsetMatch));
  }

  // Sort: store code asc, blocked first within each so problems read at the top.
  rows.sort((a, b) => {
    const sc = (a.storeCode ?? "").localeCompare(b.storeCode ?? "");
    if (sc !== 0) return sc;
    return Number(a.ready) - Number(b.ready);
  });

  const readyCount = rows.filter((r) => r.ready).length;
  const stores = new Set(
    rows.map((r) => r.storeCode).filter((s): s is string => !!s),
  ).size;

  const body: DuplicatePreviewResponse = {
    mode,
    count: rows.length,
    stores,
    ready: readyCount,
    blocked: rows.length - readyCount,
    rows,
  };
  return NextResponse.json(body);
}
