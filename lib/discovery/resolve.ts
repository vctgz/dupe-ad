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
import { isRateLimitError } from "@/lib/meta/client";
import { kvGet, kvSet } from "@/lib/kv";
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
// Cache of LIVE discovery per account. A single user flow (table load -> open modal ->
// preview -> create, plus the odd re-scan) otherwise re-pulls the whole account from
// Meta several times and trips its per-user rate limit (error 17). Re-scan passes
// forceFresh to bypass this; everything else reuses the recent pull.
//
// Two-tier: the in-process Map is L1; the shared KV store is L2, so a cold start /
// sibling serverless instance reuses a recent pull instead of hitting Meta again. Same
// TTL on both tiers — a KV hit is as fresh as a memory hit. Campaign structure changes
// a few times a day, and Re-scan is always one click away, so the window is minutes
// rather than seconds: several operators working at once then share ONE pull instead of
// each cold instance re-scanning the whole account.
const LIVE_TTL_MS = 10 * 60_000;
const liveCache = new Map<string, { at: number; result: DiscoveryResult }>();

// A "last good" copy kept far beyond the fresh TTL, purely as a rate-limit cushion.
// When Meta throttles a live pull, the L1 fallback below only helps an instance that
// already pulled successfully — which a COLD instance never has, so the operator got a
// hard "Discovery failed" instead of slightly stale data. This shared copy survives
// cold starts, so a throttled pull degrades to "Cached" for everyone.
const LAST_GOOD_TTL_SEC = 7 * 24 * 3600;

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
    const kvKey = `dupe:live:${account.slug}`;
    const lastGoodKey = `dupe:live:last:${account.slug}`;
    const cached = liveCache.get(account.slug);
    if (!opts?.forceFresh && cached && Date.now() - cached.at < LIVE_TTL_MS) {
      result = cached.result;
    } else {
      const fromKv = opts?.forceFresh ? null : await kvGet<DiscoveryResult>(kvKey);
      if (fromKv) {
        liveCache.set(account.slug, { at: Date.now(), result: fromKv });
        result = fromKv;
      } else {
        try {
          result = await loadLive(account);
          liveCache.set(account.slug, { at: Date.now(), result });
          await kvSet(kvKey, result, LIVE_TTL_MS / 1000);
          // Refresh the rate-limit cushion on every good pull.
          await kvSet(lastGoodKey, result, LAST_GOOD_TTL_SEC);
        } catch (err) {
          // Rate-limited live pull: serve the last good result (however old) marked
          // stale, so the table degrades to "Cached" instead of failing outright.
          // This instance's own memory first, else the shared long-lived copy — a cold
          // instance has no memory, which is exactly when the hard failure used to hit.
          // Any other failure, or nothing to fall back on, propagates as before.
          if (!isRateLimitError(err)) throw err;
          const fallback =
            cached?.result ?? (await kvGet<DiscoveryResult>(lastGoodKey));
          if (!fallback) throw err;
          result = { ...fallback, stale: true };
        }
      }
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
