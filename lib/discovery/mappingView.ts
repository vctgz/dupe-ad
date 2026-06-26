// Store-list data source — SERVER ONLY.
//
// For accounts that have NO discovery snapshot and NO usable Meta token but DO have
// a mapping CSV (e.g. data/mapping/<slug>.csv), we render the mapping
// itself as a STORE LIST: one row per store from the CSV, flagged MAPPED (has a
// page) or NO_PAGE (blank page). This is mode "storelist" / source "mapping".
//
// A missing mapping file is NOT an error: it returns an empty result with a note.
import "server-only";
import { getAccountBySlug } from "@/config/accounts";
import { loadMappingFile } from "@/lib/mapping";
import type { CampaignRow, DiscoveryResult } from "@/lib/discovery/types";
import { emptySummary } from "@/lib/discovery/types";

/**
 * Build the store-list DiscoveryResult for an account from its mapping CSV.
 *
 * One row per mapping entry:
 *   { storeCode, cityState, note, mappedPage (or null), sharedWith,
 *     reconcile: mappedPage ? "MAPPED" : "NO_PAGE",
 *     actualPage: null, campaignId: null, campaignName: null, hasTemplateAd: false }
 *
 * summary = counts of MAPPED / NO_PAGE (+ mapping/unique totals).
 * splitPageCodes = codes that share a page with another code (e.g. ["049","055"]).
 */
export async function buildStoreList(accountSlug: string): Promise<DiscoveryResult> {
  const account = getAccountBySlug(accountSlug);
  const accountInfo = account
    ? { id: account.id, label: account.label, slug: account.slug }
    : { id: "", label: accountSlug, slug: accountSlug };

  const { entries, splitPageCodes } = await loadMappingFile(accountSlug);

  if (entries.length === 0) {
    return {
      account: accountInfo,
      source: "mapping",
      mode: "storelist",
      fetchedAt: null,
      summary: emptySummary(),
      rows: [],
      splitPageCodes: [],
      unusedMappingCodes: [],
      note: `No mapping CSV for "${accountSlug}" — add data/mapping/${accountSlug}.csv.`,
    };
  }

  const rows: CampaignRow[] = entries.map((e) => {
    const mapped = e.page; // bare numeric page id or null
    const row: CampaignRow = {
      campaignId: null,
      campaignName: null,
      status: null,
      storeCode: e.code,
      mappedPage: mapped,
      actualPage: null,
      pageSource: "none",
      hasTemplateAd: false,
      templateAdId: null,
      instagramUserId: null,
      reconcile: mapped ? "MAPPED" : "NO_PAGE",
    };
    if (e.url !== undefined) row.url = e.url;
    if (e.cityState !== undefined) row.cityState = e.cityState;
    if (e.note !== undefined) row.note = e.note;
    if (e.sharedWith !== undefined) row.sharedWith = e.sharedWith;
    return row;
  });

  const summary = emptySummary();
  summary.totalCampaigns = rows.length;
  summary.mappingCodes = entries.length;
  const uniqueCodes = new Set<string>();
  for (const r of rows) {
    summary[r.reconcile] += 1;
    if (r.storeCode) uniqueCodes.add(r.storeCode);
  }
  summary.uniqueStoreCodes = uniqueCodes.size;
  summary.splitPageCodesCount = splitPageCodes.length;

  return {
    account: accountInfo,
    source: "mapping",
    mode: "storelist",
    fetchedAt: null,
    summary,
    rows,
    splitPageCodes,
    unusedMappingCodes: [],
  };
}
