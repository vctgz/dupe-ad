// Live data source — SERVER ONLY.
//
// Runs live Graph discovery + reconciliation and returns a unified DiscoveryResult,
// identical in shape to the snapshot source so the UI renders both the same way.
import "server-only";
import type { AdAccount } from "@/config/accounts";
import { discoverAccount } from "@/lib/meta/discovery";
import { loadMapping, reconcile } from "@/lib/mapping";
import type { DiscoveryResult } from "@/lib/discovery/types";

export async function loadLive(account: AdAccount): Promise<DiscoveryResult> {
  const [campaigns, mapping] = await Promise.all([
    discoverAccount(account),
    loadMapping(account.slug),
  ]);
  const { rows, summary, splitPageCodes, unusedMappingCodes } = reconcile(
    campaigns,
    mapping,
    account.storeCodeDigits,
  );

  return {
    account: { id: account.id, label: account.label, slug: account.slug },
    source: "live",
    mode: "reconcile",
    fetchedAt: new Date().toISOString(),
    summary,
    rows,
    splitPageCodes,
    unusedMappingCodes,
  };
}
