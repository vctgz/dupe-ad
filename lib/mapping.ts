// Mapping ingest + reconciliation — SERVER ONLY.
//
// Loads data/mapping/<slug>.csv (the operator's INTENDED page per STORE CODE) and
// reconciles it against discovery, flagging every campaign OK / MISMATCH /
// MISSING_MAPPING / MISSING_API / NO_CODE so wrong/missing page bindings are caught
// before any ad is created (data/mapping/README.md, docs/02-data-model.md).
//
// The join key is the STORE CODE: a run of exactly N digits extracted from the
// campaign name (N = account.storeCodeDigits), matched against the mapping CSV's
// "Campaign Name" column. Codes are STRINGS throughout — never Number()-cast — so
// leading zeros ("00197") are preserved.
import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import type {
  CampaignRow,
  DiscoverySummary,
  PageIdSource,
  ReconcileStatus,
} from "@/lib/discovery/types";
import { emptySummary } from "@/lib/discovery/types";

export type { ReconcileStatus } from "@/lib/discovery/types";

export interface MappingEntry {
  /** Store code as it appears in the CSV's "Campaign Name" column — a string. */
  storeCode: string;
  /**
   * Facebook Page ID this store should publish from. Derived from the
   * "Link Object ID" column with the literal `o:` prefix stripped (so
   * `o:100000000000001` -> `100000000000001`).
   */
  linkObjectId: string;
  /** Per-store landing page (destination URL) from the optional `url` column. */
  url?: string;
}

// Accepted header names (case-insensitive) for the optional per-store landing
// page column. Kept distinct from "Link Object ID" (the PAGE column) on purpose,
// so the two are never confused.
const URL_HEADER_ALIASES = new Set([
  "url",
  "landing_page",
  "landing page",
  "landing_url",
  "landing url",
  "destination",
  "destination_url",
  "destination url",
]);

/**
 * Pull the per-store landing page URL out of a parsed CSV row, matching any of the
 * accepted header aliases case-insensitively. Returns undefined when absent/blank.
 */
function pickUrl(row: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(row)) {
    if (URL_HEADER_ALIASES.has(k.trim().toLowerCase())) {
      const val = (v ?? "").trim();
      if (val) return val;
    }
  }
  return undefined;
}

/** Which CSV layout a mapping file uses (auto-detected by its header). */
export type MappingFormat = "campaign-name" | "store-number";

/**
 * Format-agnostic mapping row. Both CSV layouts normalize to this shape so the
 * store-list builder and the campaign reconcile path can share one loader.
 *   - `code` keeps leading zeros (always a string; e.g. "001", "00197").
 *   - `page` is a BARE numeric page id, or null when the store has no page.
 *   - `cityState`/`note` are present only for the store-number layout.
 *   - `sharedWith` lists OTHER codes that point at the same page id.
 */
export interface NormalizedMappingEntry {
  code: string;
  page: string | null;
  /** Per-store landing page (destination URL) from the optional `url` column. */
  url?: string;
  cityState?: string;
  note?: string;
  sharedWith?: string[];
}

export interface LoadedMapping {
  format: MappingFormat | null;
  entries: NormalizedMappingEntry[];
  /** Codes whose page is shared with at least one other code (sorted, deduped). */
  splitPageCodes: string[];
}

/** One campaign as seen by discovery, before reconciliation. */
export interface DiscoveredCampaign {
  campaignId: string | null;
  campaignName: string;
  status: string | null;
  actualPage: string | null;
  pageSource: PageIdSource;
  hasTemplateAd: boolean;
  templateAdId: string | null;
  instagramUserId: string | null;
}

/**
 * Extract the store code from a campaign name using `digits` (exact-N-digit run).
 *
 * Rules:
 *   - strip an optional leading "Paused - " / "PAUSED - " prefix (case-insensitive),
 *   - then take the FIRST run of EXACTLY `digits` digits (not part of a longer run),
 *   - return it as a STRING (leading zeros preserved), or null if none found.
 */
export function extractStoreCode(
  campaignName: string,
  digits: number,
): string | null {
  const name = campaignName.replace(/^\s*paused\s*-\s*/i, "");
  // Match a run of exactly `digits` digits not flanked by other digits.
  const re = new RegExp(`(?<!\\d)(\\d{${digits}})(?!\\d)`);
  const m = re.exec(name);
  return m ? m[1]! : null;
}

/**
 * Normalize a "Link Object ID" cell into a bare numeric Facebook page_id.
 * Strips a single leading `o:` (case-insensitive) and trims. Returns "" for blanks.
 */
export function normalizeLinkObjectId(raw: string): string {
  return raw.trim().replace(/^o:/i, "").trim();
}

function mappingPath(slug: string): string {
  return path.join(process.cwd(), "data", "mapping", `${slug}.csv`);
}

// In-process parse cache for the mapping CSV, keyed by file path + mtime. The CSV
// is a static on-disk artifact; re-running Papa.parse + the dedupe +
// annotateSharedPages pass on every request (and every account switch) is wasted
// CPU. We stat first and reuse the parsed LoadedMapping when the mtime is
// unchanged, so an edited/regenerated CSV is always re-read (Re-scan stays
// correct) while warm requests skip the parse. Per-process: cleared on redeploy.
const mappingCache = new Map<string, { mtimeMs: number; value: LoadedMapping }>();

/**
 * Detect which CSV layout a parsed header row uses:
 *   - "campaign-name": has a "Campaign Name" + "Link Object ID" column.
 *   - "store-number":  has a "store number" + "page_id" column.
 * Returns null when neither set of columns is present.
 */
function detectFormat(headerFields: string[]): MappingFormat | null {
  const fields = new Set(headerFields.map((h) => h.trim().toLowerCase()));
  if (fields.has("campaign name") && fields.has("link object id")) return "campaign-name";
  if (fields.has("store number") && fields.has("page_id")) return "store-number";
  return null;
}

/**
 * Load + auto-detect + normalize data/mapping/<slug>.csv into a format-agnostic
 * mapping. A missing file is NOT an error — it returns an empty mapping (the
 * contract: drop CSVs when ready). Handles BOTH layouts:
 *
 *   A) campaign-name — header "Campaign Name,Link Object ID".
 *      Campaign Name = bare store code (leading zeros kept).
 *      Link Object ID = page id with a literal "o:" prefix to STRIP.
 *
 *   B) store-number — header "store number,city_state,page_id,note".
 *      store number = store code (leading zeros kept).
 *      page_id = BARE numeric (no "o:"); EMPTY -> page = null.
 *      city_state + note carried through as extras.
 *
 * Across all entries it also computes `sharedWith` (other codes pointing at the
 * same page id) and the `splitPageCodes` list (every code on a shared page).
 */
/** Env var name carrying a slug's mapping CSV, e.g. "runnings" -> MAPPING_RUNNINGS. */
function mappingEnvVar(slug: string): string {
  return `MAPPING_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

// Parsed-mapping cache for the env-var source, keyed by slug; invalidated when the env
// string changes so a redeploy with an edited MAPPING_<SLUG> is always picked up.
const envMappingCache = new Map<string, { raw: string; value: LoadedMapping }>();

/** Parse raw mapping CSV text (either layout) into a normalized LoadedMapping. */
function parseMappingCsv(raw: string): LoadedMapping {
  const parsed = Papa.parse<Record<string, string>>(raw, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  const format = detectFormat(parsed.meta.fields ?? []);

  // De-dupe identical rows by (code, page): the source CSV can repeat rows.
  const seen = new Set<string>();
  const entries: NormalizedMappingEntry[] = [];
  for (const row of parsed.data) {
    let code = "";
    let page: string | null = null;
    let cityState: string | undefined;
    let note: string | undefined;

    if (format === "store-number") {
      code = (row["store number"] ?? "").trim();
      const rawPage = (row["page_id"] ?? "").trim();
      page = rawPage === "" ? null : rawPage;
      const cs = (row["city_state"] ?? "").trim();
      if (cs) cityState = cs;
      const n = (row["note"] ?? "").trim();
      if (n) note = n;
    } else {
      // Default to the campaign-name layout (also covers the legacy/example header).
      code = (row["Campaign Name"] ?? "").trim();
      const link = normalizeLinkObjectId(row["Link Object ID"] ?? "");
      page = link === "" ? null : link;
    }

    if (!code && !page) continue;

    const dedupeKey = `${code} ${page ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const url = pickUrl(row);

    const entry: NormalizedMappingEntry = { code, page };
    if (url !== undefined) entry.url = url;
    if (cityState !== undefined) entry.cityState = cityState;
    if (note !== undefined) entry.note = note;
    entries.push(entry);
  }

  const splitPageCodes = annotateSharedPages(entries);
  return { format, entries, splitPageCodes };
}

export async function loadMappingFile(slug: string): Promise<LoadedMapping> {
  // Env-var CSV wins: lets a hosted deployment supply the store->page mapping without
  // committing client data (the CSVs are gitignored/vercelignored). Set MAPPING_<SLUG>
  // (e.g. MAPPING_RUNNINGS) to the raw CSV text.
  const envCsv = process.env[mappingEnvVar(slug)];
  if (envCsv && envCsv.trim().length > 0) {
    const cached = envMappingCache.get(slug);
    if (cached && cached.raw === envCsv) return cached.value;
    const value = parseMappingCsv(envCsv);
    // A non-blank env var that parses to nothing is an operator mistake (wrong headers),
    // not "no mapping" — fail loud rather than silently mapping zero stores.
    if (value.format === null && value.entries.length === 0) {
      throw new Error(
        `${mappingEnvVar(slug)} is set but its CSV header matches neither layout ` +
          `("Campaign Name","Link Object ID" or "store number","page_id").`,
      );
    }
    envMappingCache.set(slug, { raw: envCsv, value });
    return value;
  }

  const filePath = mappingPath(slug);

  // Stat first: reuse the parsed mapping when the file is unchanged. ENOENT (or
  // any stat failure) falls through to readFile, preserving the existing
  // empty-mapping / error behavior exactly.
  let statMtimeMs: number | null = null;
  try {
    const s = await stat(filePath);
    statMtimeMs = s.mtimeMs;
    const cached = mappingCache.get(filePath);
    if (cached && cached.mtimeMs === statMtimeMs) {
      return cached.value;
    }
  } catch {
    // fall through to readFile
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { format: null, entries: [], splitPageCodes: [] };
    }
    throw err;
  }

  const result = parseMappingCsv(raw);

  if (statMtimeMs !== null) {
    mappingCache.set(filePath, { mtimeMs: statMtimeMs, value: result });
  }

  return result;
}

/**
 * Compute, across entries, which codes SHARE a non-null page id. Mutates each
 * entry to set `sharedWith` (the OTHER codes on its page) and returns the sorted,
 * deduped list of all codes that sit on a shared page (the `splitPageCodes`).
 */
function annotateSharedPages(entries: NormalizedMappingEntry[]): string[] {
  // page id -> distinct codes pointing at it.
  const codesByPage = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.page || !e.code) continue;
    const list = codesByPage.get(e.page) ?? [];
    if (!list.includes(e.code)) list.push(e.code);
    codesByPage.set(e.page, list);
  }

  const split = new Set<string>();
  for (const e of entries) {
    if (!e.page || !e.code) continue;
    const codes = codesByPage.get(e.page) ?? [];
    if (codes.length <= 1) continue;
    e.sharedWith = codes.filter((c) => c !== e.code).sort();
    split.add(e.code);
  }
  return [...split].sort();
}

/**
 * Load and parse data/mapping/<slug>.csv into the campaign reconcile shape
 * (`MappingEntry[]`). A missing file returns an empty mapping. This wraps the
 * auto-detecting loader so the existing live reconcile path is unchanged.
 */
export async function loadMapping(slug: string): Promise<MappingEntry[]> {
  const { entries } = await loadMappingFile(slug);
  return entries.map((e) => {
    const m: MappingEntry = { storeCode: e.code, linkObjectId: e.page ?? "" };
    if (e.url !== undefined) m.url = e.url;
    return m;
  });
}

/**
 * Store code -> landing page URL, from the mapping CSV's optional `url` column.
 * Codes without a URL are omitted. Shared by the Create route (each store's ad
 * links to its own landing page) and the discovery route (so the table can show
 * the landing page for snapshot-sourced accounts). A missing CSV -> empty map.
 */
export async function loadLandingUrls(slug: string): Promise<Map<string, string>> {
  const { entries } = await loadMappingFile(slug);
  const map = new Map<string, string>();
  for (const e of entries) {
    if (e.code && e.url) map.set(e.code, e.url);
  }
  return map;
}

/**
 * Reconcile discovered campaigns against the mapping, producing one CampaignRow per
 * discovered campaign plus a tally and cross-campaign diagnostics.
 *
 * Per-campaign status:
 *   NO_CODE         - no store code extractable from the campaign name.
 *   MISSING_MAPPING - code extracted but no mapping row for it.
 *   OK              - actualPage == mapped page.
 *   MISMATCH        - both present but differ.
 *   MISSING_API     - mapping has the code/page but the API produced no page.
 *
 * Cross-campaign:
 *   splitPageCodes      - a code whose campaigns resolve to >1 distinct actualPage.
 *   unusedMappingCodes  - mapping codes that never matched any discovered campaign.
 */
export function reconcile(
  campaigns: DiscoveredCampaign[],
  mapping: MappingEntry[],
  storeCodeDigits: number,
): {
  rows: CampaignRow[];
  summary: DiscoverySummary;
  splitPageCodes: string[];
  unusedMappingCodes: string[];
} {
  // Index mapping by store code. Keep first occurrence per code (CSV is de-duped).
  const mappingByCode = new Map<string, MappingEntry>();
  for (const entry of mapping) {
    if (entry.storeCode && !mappingByCode.has(entry.storeCode)) {
      mappingByCode.set(entry.storeCode, entry);
    }
  }

  const rows: CampaignRow[] = [];
  const matchedCodes = new Set<string>();
  // Distinct non-null actual pages observed per store code (for split detection).
  const actualPagesByCode = new Map<string, Set<string>>();

  for (const c of campaigns) {
    const storeCode = extractStoreCode(c.campaignName, storeCodeDigits);
    const mapEntry = storeCode ? mappingByCode.get(storeCode) : undefined;
    if (storeCode && mapEntry) matchedCodes.add(storeCode);

    const mappedPage = mapEntry?.linkObjectId || null;
    const reconcileStatus = classify({
      storeCode,
      mappingPresent: mapEntry !== undefined,
      mappedPage,
      actualPage: c.actualPage,
    });

    if (storeCode && c.actualPage) {
      const set = actualPagesByCode.get(storeCode) ?? new Set<string>();
      set.add(c.actualPage);
      actualPagesByCode.set(storeCode, set);
    }

    const row: CampaignRow = {
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      status: c.status,
      storeCode,
      mappedPage,
      actualPage: c.actualPage,
      pageSource: c.pageSource,
      hasTemplateAd: c.hasTemplateAd,
      templateAdId: c.templateAdId,
      instagramUserId: c.instagramUserId,
      reconcile: reconcileStatus,
    };
    if (mapEntry?.url) row.url = mapEntry.url;
    rows.push(row);
  }

  // Cross-campaign diagnostics.
  const splitPageCodes = [...actualPagesByCode.entries()]
    .filter(([, pages]) => pages.size > 1)
    .map(([code]) => code)
    .sort();

  const unusedMappingCodes = [...mappingByCode.keys()]
    .filter((code) => !matchedCodes.has(code))
    .sort();

  // Summary tally.
  const summary: DiscoverySummary = emptySummary();
  summary.totalCampaigns = rows.length;
  const uniqueCodes = new Set<string>();
  for (const r of rows) {
    summary[r.reconcile] += 1;
    if (r.storeCode) uniqueCodes.add(r.storeCode);
    if (r.hasTemplateAd) summary.campaignsWithTemplateAd += 1;
  }
  summary.uniqueStoreCodes = uniqueCodes.size;
  summary.mappingCodes = mappingByCode.size;
  summary.unusedMappingCodesCount = unusedMappingCodes.length;
  summary.splitPageCodesCount = splitPageCodes.length;

  return { rows, summary, splitPageCodes, unusedMappingCodes };
}

function classify(args: {
  storeCode: string | null;
  mappingPresent: boolean;
  mappedPage: string | null;
  actualPage: string | null;
}): ReconcileStatus {
  const { storeCode, mappingPresent, mappedPage, actualPage } = args;

  // No store code at all — can't reconcile.
  if (!storeCode) return "NO_CODE";

  // Code present but no mapping row for it.
  if (!mappingPresent) return "MISSING_MAPPING";

  // Mapping present but blank Link Object ID — treat as missing mapping.
  if (!mappedPage) return "MISSING_MAPPING";

  // Mapping has a page but the API produced none.
  if (!actualPage) return "MISSING_API";

  return actualPage === mappedPage ? "OK" : "MISMATCH";
}
