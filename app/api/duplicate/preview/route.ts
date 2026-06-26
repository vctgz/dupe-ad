// POST /api/duplicate/preview
// DRY-RUN duplication planner. NO WRITES — produces no Meta calls of any kind.
// Loads the SAME discovery snapshot the table renders, then for each selected
// campaignId emits a plan row describing where a duplicated ad WOULD land (the
// store's own resolved Page) and whether that target is ready.
//
// This is the read-only seam in front of the Phase 1 live write engine: the
// modal previews the plan; nothing is created here.
//
// Auth-protected exactly like the other JSON APIs (reuses the route guard).
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAccountBySlug } from "@/config/accounts";
import { loadSnapshot } from "@/lib/discovery/snapshot";
import { authorizeAccount } from "@/lib/route-guard";
import type { ApiError } from "@/lib/types";
import type { CampaignRow } from "@/lib/discovery/types";

export const dynamic = "force-dynamic";

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

  // Readiness: a resolved Page always required; create mode also needs a link.
  const ready = mode === "create" ? hasPage && link.trim().length > 0 : hasPage;

  let blockReason: string | null = null;
  if (!ready) {
    if (!hasPage) {
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

  // Snapshot for now — the SAME source the discovery table reads. No live Meta
  // calls of any kind here; this is a dry run.
  const discovery = await loadSnapshot(account);

  const byId = new Map<string, CampaignRow>();
  for (const r of discovery.rows) {
    if (r.campaignId) byId.set(r.campaignId, r);
  }

  const wanted = new Set(campaignIds);
  const rows: DuplicatePlanRow[] = [];
  for (const id of wanted) {
    const row = byId.get(id);
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
        ready: false,
        blockReason: "Campaign not found in the latest discovery snapshot — re-scan.",
      });
      continue;
    }
    rows.push(planRow(row, mode, adName, link));
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
