// GET /api/discovery?account=<slug>[&source=auto|snapshot|live]
// Returns one row PER CAMPAIGN with reconciliation, plus a summary + diagnostics.
//
// Source selection (DISCOVERY_SOURCE env, overridable per-request via ?source=):
//   auto      -> LIVE when usable Meta creds exist for the account, else SNAPSHOT.
//   snapshot  -> always read data/discovery/<slug>.json.
//   live      -> always hit the Graph API (400 if creds are missing).
//
// With only APP_ACCESS_PASSCODE set this resolves to SNAPSHOT for every account, so
// the app renders the real on-disk discovery with no Meta token.
import { access } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getAccountBySlug } from "@/config/accounts";
import { loadLandingUrls } from "@/lib/mapping";
import { getEnv, hasLiveCredentials, LiveCredentialsError } from "@/lib/env";
import { loadSnapshot } from "@/lib/discovery/snapshot";
import { loadLive } from "@/lib/discovery/live";
import { buildStoreList } from "@/lib/discovery/mappingView";
import { MetaApiError } from "@/lib/meta/client";
import { authorizeAccount } from "@/lib/route-guard";
import type { DiscoverySource } from "@/lib/discovery/types";
import type { ApiError, DiscoveryResponse } from "@/lib/types";

/** True when data/discovery/<slug>.json exists on disk. */
async function snapshotExists(slug: string): Promise<boolean> {
  try {
    await access(path.join(process.cwd(), "data", "discovery", `${slug}.json`));
    return true;
  } catch {
    return false;
  }
}

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
): Promise<NextResponse<DiscoveryResponse | ApiError>> {
  // Resolve + authorize the account (open when AUTH_ENABLED is off; session-locked when on).
  const authz = authorizeAccount(req.nextUrl.searchParams.get("account"));
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }
  const slug = authz.slug;

  const account = getAccountBySlug(slug);
  if (!account) {
    return NextResponse.json({ error: `Unknown account "${slug}"` }, { status: 400 });
  }

  // Resolve the source: explicit ?source= overrides DISCOVERY_SOURCE; "auto" picks
  // live (usable creds) -> snapshot (data/discovery/<slug>.json exists) -> mapping
  // store-list (data/mapping/<slug>.csv). An account with a snapshot resolves to
  // snapshot; an account with no token and no snapshot resolves to the mapping store-list.
  const requested = (req.nextUrl.searchParams.get("source") ?? getEnv().DISCOVERY_SOURCE) as
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

  try {
    let result;
    if (source === "live") result = await loadLive(account);
    else if (source === "mapping") result = await buildStoreList(account.slug);
    else result = await loadSnapshot(account);

    // The live + store-list sources already attach landing URLs from the mapping.
    // Snapshots are pre-computed and may predate the `url` column, so merge the
    // current mapping's URLs onto a fresh rows copy (never mutate the cached
    // snapshot) so the table shows them without regenerating the snapshot.
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

    // Surface whether live ad creation is possible for this account (write token +
    // app creds present). Read-only snapshot mode → false.
    result.writeEnabled = hasLiveCredentials(account.tokenEnvVar);
    // Account-scoped data — never let a browser or shared proxy cache it across sessions.
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    if (err instanceof LiveCredentialsError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof MetaApiError) {
      // eslint-disable-next-line no-console
      console.error(
        `[discovery] Meta API error for ${account.slug}: code=${err.code} subcode=${err.subcode} type=${err.type} http=${err.httpStatus} trace=${err.fbtraceId} — ${err.message}`,
      );
      return NextResponse.json(
        { error: `Meta API error (${err.code ?? "?"}): ${err.message}` },
        { status: 502 },
      );
    }
    // eslint-disable-next-line no-console
    console.error(`[discovery] unexpected error for ${account.slug}:`, err);
    // Generic client message; the detailed error stays in the server log only.
    return NextResponse.json({ error: "Discovery failed" }, { status: 500 });
  }
}
