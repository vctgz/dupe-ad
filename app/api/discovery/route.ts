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
import { NextRequest, NextResponse } from "next/server";
import { getAccountBySlug } from "@/config/accounts";
import { hasLiveCredentials, LiveCredentialsError } from "@/lib/env";
import { resolveDiscoveryResult } from "@/lib/discovery/resolve";
import { MetaApiError, metaErrorToMessage } from "@/lib/meta/client";
import { authorizeAccount } from "@/lib/route-guard";
import type { ApiError, DiscoveryResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
// Live discovery on a large account fans out across many paginated /ads calls, which
// can exceed Vercel's short default function timeout. Give it real headroom (60s is the
// Hobby ceiling; Pro allows more if you ever need it).
export const maxDuration = 60;

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

  try {
    const result = await resolveDiscoveryResult(
      account,
      req.nextUrl.searchParams.get("source"),
      { forceFresh: req.nextUrl.searchParams.get("refresh") === "1" },
    );

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
        { error: metaErrorToMessage(err) },
        { status: 502 },
      );
    }
    // eslint-disable-next-line no-console
    console.error(`[discovery] unexpected error for ${account.slug}:`, err);
    // Generic client message; the detailed error stays in the server log only.
    return NextResponse.json({ error: "Discovery failed" }, { status: 500 });
  }
}
