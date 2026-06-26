// Discovery service — SERVER ONLY.
//
// For a given ad account, reads campaigns + ads live from the Graph API and derives,
// per campaign: whether a Template ad exists, the page_id (with provenance), and the
// instagram_user_id. This is the read-only seed of the store->page map described in
// docs/02-data-model.md §2. No DB in Phase 0 — we read live and return typed rows
// in the SAME shape the snapshot loader produces, so both feed one reconciler.
import "server-only";
import { get, resolveToken, MetaApiError } from "@/lib/meta/client";
import type { AdAccount } from "@/config/accounts";
import type { PageIdSource } from "@/lib/discovery/types";
import type { DiscoveredCampaign } from "@/lib/mapping";

export type { PageIdSource } from "@/lib/discovery/types";

/** Raw shapes returned by the Graph API (only the fields we request). */
interface MetaCampaign {
  id: string;
  name?: string;
  objective?: string;
  effective_status?: string;
}

interface MetaCreative {
  id?: string;
  name?: string;
  object_story_spec?: {
    page_id?: string;
    instagram_user_id?: string;
  };
  effective_object_story_id?: string;
}

interface MetaAd {
  id: string;
  name?: string;
  adset_id?: string;
  campaign_id?: string;
  effective_status?: string;
  creative?: MetaCreative;
}

const CAMPAIGN_FIELDS = "id,name,objective,effective_status";
// NOTE: deliberately NO asset_feed_spec — it's the entire dynamic-creative blob, the
// single heaviest field Meta can return, and nothing here reads it. Requesting it
// across a whole account is the classic trigger for Meta error #1 ("reduce the amount
// of data you're asking for").
const AD_FIELDS =
  "id,name,adset_id,campaign_id,effective_status," +
  "creative{id,name,object_story_spec{page_id,instagram_user_id}," +
  "effective_object_story_id}";

// Page sizes to try for the account-level /ads pull, largest first. The nested
// creative{} expansion makes this the heaviest call; large accounts can trip Meta
// error #1 at big page sizes, so we back off to smaller pages before giving up.
const AD_PAGE_SIZES = [50, 25, 10] as const;

/**
 * Fetch all of an account's ads with nested creative, backing off to smaller page
 * sizes if Meta returns error #1 ("reduce the amount of data"). Any other error
 * propagates immediately.
 */
async function getAdsResilient(actId: string, token: string): Promise<MetaAd[]> {
  let lastErr: unknown;
  for (const limit of AD_PAGE_SIZES) {
    try {
      return await get<MetaAd>(`${actId}/ads`, { fields: AD_FIELDS, limit }, token);
    } catch (err) {
      // Code 1 = the per-page query was too expensive; retry with a smaller page.
      if (err instanceof MetaApiError && err.code === 1) {
        lastErr = err;
        // eslint-disable-next-line no-console
        console.warn(`[meta] /ads too large at limit=${limit}; backing off`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Exact, case-insensitive Template-name match against TEMPLATE_AD_NAME (default "Template"). */
function templateName(): string {
  return (process.env.TEMPLATE_AD_NAME ?? "Template").trim().toLowerCase();
}

function isTemplateAd(ad: MetaAd, target: string): boolean {
  return (ad.name ?? "").trim().toLowerCase() === target;
}

/** Extract page_id + provenance from a creative (object_story_spec preferred). */
function pageIdFromCreative(
  creative: MetaCreative | undefined,
): { pageId: string | null; source: PageIdSource } {
  if (!creative) return { pageId: null, source: "none" };

  const ossPage = creative.object_story_spec?.page_id;
  if (ossPage && ossPage.length > 0) {
    return { pageId: ossPage, source: "object_story_spec" };
  }

  // Fallback: effective_object_story_id has the form `{page_id}_{post_id}`.
  const eosi = creative.effective_object_story_id;
  if (eosi && eosi.includes("_")) {
    const prefix = eosi.split("_", 1)[0];
    if (prefix && prefix.length > 0) {
      return { pageId: prefix, source: "effective_object_story_id" };
    }
  }

  return { pageId: null, source: "none" };
}

/** Most-common non-null page_id across a campaign's ads, with provenance preference. */
function mostCommonPageId(
  ads: MetaAd[],
): { pageId: string | null; source: PageIdSource; instagramUserId: string | null } {
  const tally = new Map<string, { count: number; source: PageIdSource }>();
  let instagramUserId: string | null = null;

  for (const ad of ads) {
    const ig = ad.creative?.object_story_spec?.instagram_user_id;
    if (ig && !instagramUserId) instagramUserId = ig;

    const { pageId, source } = pageIdFromCreative(ad.creative);
    if (!pageId) continue;
    const existing = tally.get(pageId);
    if (existing) {
      existing.count += 1;
      if (source === "object_story_spec") existing.source = "object_story_spec";
    } else {
      tally.set(pageId, { count: 1, source });
    }
  }

  let best: { pageId: string; count: number; source: PageIdSource } | null = null;
  for (const [pageId, { count, source }] of tally) {
    if (!best || count > best.count) best = { pageId, count, source };
  }

  if (!best) return { pageId: null, source: "none", instagramUserId };
  return { pageId: best.pageId, source: best.source, instagramUserId };
}

/**
 * Run live discovery for one ad account. Returns one DiscoveredCampaign per campaign,
 * matching the snapshot JSON shape so lib/mapping.reconcile can consume either source.
 */
export async function discoverAccount(
  account: AdAccount,
): Promise<DiscoveredCampaign[]> {
  const token = resolveToken(account);
  const actId = `act_${account.id}`;
  const target = templateName();

  // 1. Campaigns (paginated).
  const campaigns = await get<MetaCampaign>(
    `${actId}/campaigns`,
    { fields: CAMPAIGN_FIELDS, limit: 200 },
    token,
  );

  // 2. Ads at the account level, nested creative, paginated with adaptive page size.
  const ads = await getAdsResilient(actId, token);

  // 3. Group ads by campaign_id.
  const adsByCampaign = new Map<string, MetaAd[]>();
  for (const ad of ads) {
    const cid = ad.campaign_id;
    if (!cid) continue;
    const bucket = adsByCampaign.get(cid);
    if (bucket) bucket.push(ad);
    else adsByCampaign.set(cid, [ad]);
  }

  // 4. Build one row per campaign.
  return campaigns.map((c) => {
    const campaignAds = adsByCampaign.get(c.id) ?? [];

    // Identify the Template ad(s) by exact, case-insensitive name match.
    const templateMatches = campaignAds.filter((a) => isTemplateAd(a, target));
    const templateAd = templateMatches[0] ?? null;

    // Page id: prefer the Template ad's creative; else most common across the campaign.
    let actualPage: string | null = null;
    let pageSource: PageIdSource = "none";
    let instagramUserId: string | null = null;

    if (templateAd) {
      const fromTemplate = pageIdFromCreative(templateAd.creative);
      actualPage = fromTemplate.pageId;
      pageSource = fromTemplate.source;
      instagramUserId =
        templateAd.creative?.object_story_spec?.instagram_user_id ?? null;
    }

    if (!actualPage) {
      const common = mostCommonPageId(campaignAds);
      actualPage = common.pageId;
      pageSource = common.source;
      if (!instagramUserId) instagramUserId = common.instagramUserId;
    }

    return {
      campaignId: c.id,
      campaignName: c.name ?? "",
      status: c.effective_status ?? null,
      actualPage,
      pageSource,
      hasTemplateAd: templateAd !== null,
      templateAdId: templateAd?.id ?? null,
      instagramUserId,
    } satisfies DiscoveredCampaign;
  });
}
