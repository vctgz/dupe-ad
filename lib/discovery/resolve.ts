// Shared discovery resolution — SERVER ONLY.
//
// Resolves WHICH source (live | snapshot | mapping) an account should use and loads it,
// returning a unified DiscoveryResult. Used by BOTH the discovery route (read path) and
// the create route, so live writes resolve each store's Page from the SAME source the
// table shows — not a snapshot that may not exist in production.
import "server-only";
import { access } from "node:fs/promises";
import path from "node:path";
import type { AdAccount } from "@/config/accounts";
import { getEnv, hasLiveCredentials } from "@/lib/env";
import { loadSnapshot } from "@/lib/discovery/snapshot";
import { loadLive } from "@/lib/discovery/live";
import { buildStoreList } from "@/lib/discovery/mappingView";
import { loadLandingUrls } from "@/lib/mapping";
import type { DiscoveryResult, DiscoverySource } from "@/lib/discovery/types";

/** True when data/discovery/<slug>.json exists on disk. */
async function snapshotExists(slug: string): Promise<boolean> {
  try {
    await access(path.join(process.cwd(), "data", "discovery", `${slug}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the discovery source for an account and load it.
 *   - an explicit source ("live" | "snapshot" | "mapping"), from `sourceOverride`
 *     (the route's ?source=) or DISCOVERY_SOURCE, is honored as-is;
 *   - "auto" picks LIVE when usable Meta creds exist, else the on-disk SNAPSHOT,
 *     else the MAPPING store-list.
 * For the snapshot source, current mapping landing URLs are merged onto a fresh rows
 * copy (snapshots predate the `url` column).
 */
// Short-TTL cache of LIVE discovery per account. A single user flow (table load -> open
// modal -> preview -> create, plus the odd re-scan) otherwise re-pulls the whole account
// from Meta several times and trips its per-user rate limit (error 17). Re-scan passes
// forceFresh to bypass this; everything else reuses the recent pull.
const LIVE_TTL_MS = 90_000;
const liveCache = new Map<string, { at: number; result: DiscoveryResult }>();

export async function resolveDiscoveryResult(
  account: AdAccount,
  sourceOverride?: string | null,
  opts?: { forceFresh?: boolean },
): Promise<DiscoveryResult> {
  const requested = (sourceOverride ?? getEnv().DISCOVERY_SOURCE) as
    | DiscoverySource
    | "auto";

  let source: DiscoverySource;
  if (requested === "live" || requested === "snapshot" || requested === "mapping") {
    source = requested;
  } else if (hasLiveCredentials(account.tokenEnvVar)) {
    source = "live";
  } else if (await snapshotExists(account.slug)) {
    source = "snapshot";
  } else {
    source = "mapping";
  }

  let result: DiscoveryResult;
  if (source === "live") {
    const cached = liveCache.get(account.slug);
    if (!opts?.forceFresh && cached && Date.now() - cached.at < LIVE_TTL_MS) {
      result = cached.result;
    } else {
      result = await loadLive(account);
      liveCache.set(account.slug, { at: Date.now(), result });
    }
  } else if (source === "mapping") {
    result = await buildStoreList(account.slug);
  } else {
    result = await loadSnapshot(account);
  }

  // Snapshots are pre-computed and may predate the mapping's `url` column, so merge the
  // current mapping's landing URLs onto a fresh rows copy (never mutate the cached one).
  if (source === "snapshot") {
    const landingUrls = await loadLandingUrls(account.slug);
    if (landingUrls.size > 0) {
      result = {
        ...result,
        rows: result.rows.map((r) => {
          const u = r.storeCode ? landingUrls.get(r.storeCode) : undefined;
          return u ? { ...r, url: u } : r;
        }),
      };
    }
  }

  return result;
}
