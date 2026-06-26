// Snapshot data source — SERVER ONLY.
//
// Loads a pre-computed discovery snapshot from data/discovery/<slug>.json (produced
// out-of-band by the discovery script) and returns it in the unified DiscoveryResult
// shape. This lets the UI render the FULL reconciliation with NO Meta Graph token —
// the app boots and works with only APP_ACCESS_PASSCODE configured.
//
// A missing file is NOT an error: it returns an empty result with a clear `note`.
import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AdAccount } from "@/config/accounts";
import type { CampaignRow, DiscoveryResult } from "@/lib/discovery/types";
import { emptySummary } from "@/lib/discovery/types";

const pageSourceSchema = z.enum([
  "object_story_spec",
  "effective_object_story_id",
  "none",
]);

const reconcileSchema = z.enum([
  "OK",
  "MISMATCH",
  "MISSING_MAPPING",
  "MISSING_API",
  "NO_CODE",
  "API_ERROR",
  "MAPPED",
  "NO_PAGE",
]);

// The snapshot's per-campaign row. Tolerant on optional/nullable fields.
const campaignSchema = z.object({
  campaignId: z.string().nullable().default(null),
  campaignName: z.string(),
  status: z.string().nullable().default(null),
  storeCode: z.string().nullable().default(null),
  mappedPage: z.string().nullable().default(null),
  actualPage: z.string().nullable().default(null),
  pageSource: pageSourceSchema.catch("none"),
  hasTemplateAd: z.boolean().default(false),
  templateAdId: z.string().nullable().default(null),
  instagramUserId: z.string().nullable().default(null),
  reconcile: reconcileSchema,
  // Per-store landing page (destination URL), optional.
  url: z.string().optional(),
  // Per-account classification columns (optional; see CampaignRow).
  sg: z.enum(["Y", "N"]).optional(),
  tier: z.string().nullable().optional(),
  cityState: z.string().optional(),
  sharedWith: z.array(z.string()).optional(),
});

/** Parse a "Tier N" label out of a campaign name (reconcile mode), or null. */
function parseTier(name: string): string | null {
  const m = /\bTier\s*(\d+)\b/i.exec(name);
  return m ? `Tier ${m[1]}` : null;
}

const summarySchema = z
  .object({
    totalCampaigns: z.number(),
    uniqueStoreCodes: z.number(),
    mappingCodes: z.number(),
    OK: z.number(),
    MISMATCH: z.number(),
    MISSING_MAPPING: z.number(),
    MISSING_API: z.number(),
    NO_CODE: z.number(),
    API_ERROR: z.number().default(0),
    MAPPED: z.number().default(0),
    NO_PAGE: z.number().default(0),
    campaignsWithTemplateAd: z.number().default(0),
    unusedMappingCodesCount: z.number().default(0),
    splitPageCodesCount: z.number().default(0),
  })
  .passthrough();

const snapshotSchema = z.object({
  account: z.string().optional(),
  accountName: z.string().optional(),
  // 'reconcile' vs 'storelist'. Older snapshots omit it
  // and default to reconcile, so they render exactly as before.
  mode: z.enum(["reconcile", "storelist"]).default("reconcile"),
  fetchedAt: z.string().nullable().default(null),
  summary: summarySchema,
  campaigns: z.array(campaignSchema),
  splitPageCodes: z.array(z.string()).default([]),
  unusedMappingCodes: z.array(z.string()).default([]),
});

export type SnapshotShape = z.infer<typeof snapshotSchema>;

function snapshotPath(slug: string): string {
  return path.join(process.cwd(), "data", "discovery", `${slug}.json`);
}

// In-process parse cache, keyed by file path + mtime. The snapshot is a static
// on-disk artifact regenerated out-of-band, so re-reading + JSON.parse + Zod
// validation on every request is wasted CPU. We stat first (cheap, sub-ms) and
// only re-parse when the mtime changes — so a regenerated snapshot (e.g. via the
// Re-scan button after re-running discovery) is always picked up, while warm
// requests skip the parse entirely. Per-process: a new deploy starts cold.
const snapshotCache = new Map<string, { mtimeMs: number; value: DiscoveryResult }>();

/**
 * Load and validate the snapshot for an account. Returns a unified DiscoveryResult.
 * Missing file -> empty result with a `note`. Malformed file -> throws (caller maps
 * to a 500) so a corrupt snapshot is loud, not silent.
 */
export async function loadSnapshot(account: AdAccount): Promise<DiscoveryResult> {
  const filePath = snapshotPath(account.slug);
  const accountInfo = { id: account.id, label: account.label, slug: account.slug };

  // Stat first: if the file is unchanged since we last parsed it, reuse the cached
  // result and skip readFile + JSON.parse + Zod entirely. ENOENT falls through to
  // the existing read path, which handles the "no snapshot yet" empty result.
  let statMtimeMs: number | null = null;
  try {
    const s = await stat(filePath);
    statMtimeMs = s.mtimeMs;
    const cached = snapshotCache.get(filePath);
    if (cached && cached.mtimeMs === statMtimeMs) {
      return cached.value;
    }
  } catch {
    // No stat (e.g. ENOENT) — fall through to readFile, which produces the
    // canonical empty-result/error behavior unchanged.
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        account: accountInfo,
        source: "snapshot",
        mode: "reconcile",
        fetchedAt: null,
        summary: emptySummary(),
        rows: [],
        splitPageCodes: [],
        unusedMappingCodes: [],
        note: "No discovery snapshot yet — run discovery for this account.",
      };
    }
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Snapshot for "${account.slug}" is not valid JSON.`);
  }

  const parsed = snapshotSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "unknown";
    throw new Error(`Snapshot for "${account.slug}" has an unexpected shape (${where}).`);
  }
  const data = parsed.data;

  // If the snapshot didn't record fetchedAt, fall back to the file's mtime so the UI
  // can still show "when". Reuse the mtime from the cache-probe stat above when we
  // have it (avoids a second stat syscall on the parse path).
  let fetchedAt = data.fetchedAt;
  if (!fetchedAt) {
    if (statMtimeMs !== null) {
      fetchedAt = new Date(statMtimeMs).toISOString();
    } else {
      try {
        const s = await stat(filePath);
        fetchedAt = s.mtime.toISOString();
      } catch {
        fetchedAt = null;
      }
    }
  }

  const rows: CampaignRow[] = data.campaigns.map((c) => {
    const row: CampaignRow = {
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      status: c.status,
      storeCode: c.storeCode,
      mappedPage: c.mappedPage,
      actualPage: c.actualPage,
      pageSource: c.pageSource,
      hasTemplateAd: c.hasTemplateAd,
      templateAdId: c.templateAdId,
      instagramUserId: c.instagramUserId,
      reconcile: c.reconcile,
      // Tier: prefer an explicit value, else derive "Tier N" from the name.
      tier: c.tier ?? parseTier(c.campaignName),
    };
    if (c.url !== undefined) row.url = c.url;
    if (c.sg !== undefined) row.sg = c.sg;
    if (c.cityState !== undefined) row.cityState = c.cityState;
    if (c.sharedWith !== undefined) row.sharedWith = c.sharedWith;
    return row;
  });

  const result: DiscoveryResult = {
    account: accountInfo,
    source: "snapshot",
    mode: data.mode,
    fetchedAt,
    summary: {
      totalCampaigns: data.summary.totalCampaigns,
      uniqueStoreCodes: data.summary.uniqueStoreCodes,
      mappingCodes: data.summary.mappingCodes,
      OK: data.summary.OK,
      MISMATCH: data.summary.MISMATCH,
      MISSING_MAPPING: data.summary.MISSING_MAPPING,
      MISSING_API: data.summary.MISSING_API,
      NO_CODE: data.summary.NO_CODE,
      API_ERROR: data.summary.API_ERROR,
      MAPPED: data.summary.MAPPED,
      NO_PAGE: data.summary.NO_PAGE,
      campaignsWithTemplateAd: data.summary.campaignsWithTemplateAd,
      unusedMappingCodesCount: data.summary.unusedMappingCodesCount,
      splitPageCodesCount: data.summary.splitPageCodesCount,
    },
    rows,
    splitPageCodes: data.splitPageCodes,
    unusedMappingCodes: data.unusedMappingCodes,
  };

  // Cache the parsed result keyed by mtime so the next warm request skips the
  // parse. Only cache when we have an mtime to key on (we always do unless the
  // file vanished between stat and read — in which case we simply don't cache).
  if (statMtimeMs !== null) {
    snapshotCache.set(filePath, { mtimeMs: statMtimeMs, value: result });
  }

  return result;
}
