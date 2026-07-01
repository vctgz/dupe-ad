// Shared, CLIENT-SAFE discovery types. Mirrors the on-disk snapshot JSON shape
// (data/discovery/<slug>.json) so the snapshot source and the live source produce
// IDENTICAL rows and both feed one renderer. Imports no secrets / server-only code.

/** Where a campaign's page_id was derived from. */
export type PageIdSource =
  | "object_story_spec"
  | "effective_object_story_id"
  | "none";

/**
 * Per-campaign reconcile verdict (mode "reconcile"):
 *   OK              - actual page == mapped page.
 *   MISMATCH        - both present but differ.
 *   MISSING_MAPPING - a store code was found but no mapping row exists for it.
 *   MISSING_API     - mapping has the code but the API produced no page/campaign.
 *   NO_CODE         - no store code could be extracted from the campaign name.
 *   API_ERROR       - the API errored for this campaign (live source only).
 *
 * Store-list verdict (mode "storelist"):
 *   MAPPED          - store has a page in the mapping, ready to use.
 *   NO_PAGE         - store has no page in the mapping.
 */
export type ReconcileStatus =
  | "OK"
  | "MISMATCH"
  | "MISSING_MAPPING"
  | "MISSING_API"
  | "NO_CODE"
  | "API_ERROR"
  | "MAPPED"
  | "NO_PAGE";

/**
 * One row — the shared unit every source renders. In mode "reconcile" (reconcile
 * mode) a row is one CAMPAIGN; in mode "storelist" (store-list mode) a row is one STORE from the
 * mapping CSV. The fields below cover both: campaign-only fields are nullable/false
 * for store-list rows, and the store-list-only fields are optional.
 */
export interface CampaignRow {
  /** null for store-list rows (no campaign). */
  campaignId: string | null;
  /** null for store-list rows. */
  campaignName: string | null;
  /** Campaign effective status, e.g. "ACTIVE" / "PAUSED". null for store-list rows. */
  status: string | null;
  /** Extracted/mapping store code (string — leading zeros preserved), or null. */
  storeCode: string | null;
  /** Page id the mapping says this store should publish from. */
  mappedPage: string | null;
  /** Page id observed live in the account, or from the snapshot. null for store-list rows. */
  actualPage: string | null;
  pageSource: PageIdSource;
  hasTemplateAd: boolean;
  templateAdId: string | null;
  instagramUserId: string | null;
  /** The reconcile/store-list verdict for this row. */
  reconcile: ReconcileStatus;

  /**
   * Per-store landing page (destination URL), from the mapping CSV's optional
   * `url` column. When set, a created ad for this store links here instead of the
   * single Destination URL typed in the Create modal. Absent when no URL is mapped.
   */
  url?: string;

  // --- Store-list (mapping) extras — OPTIONAL so reconcile rows are unaffected. ---
  /** Store-list "city_state" column. */
  cityState?: string;
  /** Store-list "note" column ("NO PAGE in list", "SHARED page (049,055)", ...). */
  note?: string;
  /** Other store codes that share this same page id. */
  sharedWith?: string[];

  // --- Per-account classification columns (the unified table's special column). ---
  /** Store-list only: "SG" flag. "Y" / "N". Sourced from data/tags/<slug>-sg.txt. */
  sg?: "Y" | "N";
  /** Reconcile only: tier label (e.g. "Tier 1"), derived from the campaign name. */
  tier?: string | null;
}

/**
 * Status tally + cross-campaign diagnostics, mirrors the snapshot `summary`.
 * Keyed by every ReconcileStatus so `summary[row.reconcile] += 1` is type-safe in
 * both modes; reconcile mode leaves MAPPED/NO_PAGE at 0, store-list mode leaves the
 * campaign-reconcile statuses at 0.
 */
export interface DiscoverySummary {
  totalCampaigns: number;
  uniqueStoreCodes: number;
  mappingCodes: number;
  OK: number;
  MISMATCH: number;
  MISSING_MAPPING: number;
  MISSING_API: number;
  NO_CODE: number;
  API_ERROR: number;
  MAPPED: number;
  NO_PAGE: number;
  campaignsWithTemplateAd: number;
  unusedMappingCodesCount: number;
  splitPageCodesCount: number;
}

export type DiscoverySource = "snapshot" | "live" | "mapping";

/**
 * Render mode for a DiscoveryResult:
 *   reconcile - one row per CAMPAIGN with page reconciliation (reconcile mode).
 *   storelist - one row per STORE from the mapping CSV (store-list mode).
 */
export type DiscoveryMode = "reconcile" | "storelist";

/** Account info exposed to the client (no tokens). */
export interface AccountInfo {
  id: string;
  label: string;
  slug: string;
}

/**
 * The unified discovery result both the snapshot loader and the live discovery
 * produce, and the API returns verbatim.
 */
export interface DiscoveryResult {
  account: AccountInfo;
  source: DiscoverySource;
  /** reconcile (campaigns) | storelist (stores from mapping). */
  mode: DiscoveryMode;
  /** ISO timestamp of when the data was produced; may be null for old snapshots. */
  fetchedAt: string | null;
  summary: DiscoverySummary;
  rows: CampaignRow[];
  /** Store codes whose campaigns resolve to >1 distinct actual page. */
  splitPageCodes: string[];
  /** Mapping codes that never matched any discovered campaign. */
  unusedMappingCodes: string[];
  /** Optional human note, e.g. when no snapshot exists yet. */
  note?: string;
  /** True when a live pull failed on Meta's rate limit and this is the last good
   *  result served from cache instead. The UI pill shows "Cached". */
  stale?: boolean;
  /** True when this account has Meta WRITE credentials configured (enables live
   *  ad creation). The data sources leave it undefined; the API route sets it. */
  writeEnabled?: boolean;
}

export function emptySummary(): DiscoverySummary {
  return {
    totalCampaigns: 0,
    uniqueStoreCodes: 0,
    mappingCodes: 0,
    OK: 0,
    MISMATCH: 0,
    MISSING_MAPPING: 0,
    MISSING_API: 0,
    NO_CODE: 0,
    API_ERROR: 0,
    MAPPED: 0,
    NO_PAGE: 0,
    campaignsWithTemplateAd: 0,
    unusedMappingCodesCount: 0,
    splitPageCodesCount: 0,
  };
}
