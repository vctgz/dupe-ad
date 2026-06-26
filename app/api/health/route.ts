// GET /api/health?account=<slug>
// Light token check: GET /act_<id>?fields=name,account_status. Returns ok/fail +
// account name, used to render the token-health pill. A MetaApiError here means the
// token is invalid/expired or the account is unassigned (alert on code 190, #9).
import { NextRequest, NextResponse } from "next/server";
import { getAccountBySlug } from "@/config/accounts";
import { getObject, MetaApiError, resolveToken } from "@/lib/meta/client";
import { hasLiveCredentials, LiveCredentialsError } from "@/lib/env";
import { authorizeAccount } from "@/lib/route-guard";
import type { ApiError, HealthResponse } from "@/lib/types";

export const dynamic = "force-dynamic";

interface AccountObject {
  name?: string;
  account_status?: number;
}

export async function GET(
  req: NextRequest,
): Promise<NextResponse<HealthResponse | ApiError>> {
  const authz = authorizeAccount(req.nextUrl.searchParams.get("account"));
  if (!authz.ok) {
    return NextResponse.json({ error: authz.error }, { status: authz.status });
  }
  const slug = authz.slug;

  const account = getAccountBySlug(slug);
  if (!account) {
    return NextResponse.json({ error: `Unknown account "${slug}"` }, { status: 400 });
  }

  // Snapshot mode: no Meta credentials configured. Report a neutral "no token"
  // state instead of failing — the app still serves snapshots.
  if (!hasLiveCredentials(account.tokenEnvVar)) {
    const body: HealthResponse = {
      ok: false,
      accountName: null,
      accountStatus: null,
      message: "Snapshot mode — no Meta credentials configured (live disabled).",
    };
    // This branch is a constant for the lifetime of the deploy (it only changes
    // if credentials are added, which restarts the server). Let the browser hold
    // it briefly so account switches don't re-fetch a guaranteed-constant body.
    // The live branch below stays uncached so token health is always fresh.
    return NextResponse.json(body, {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  }

  try {
    const token = resolveToken(account);
    const obj = await getObject<AccountObject>(
      `act_${account.id}`,
      { fields: "name,account_status" },
      token,
    );
    const body: HealthResponse = {
      ok: true,
      accountName: obj.name ?? null,
      accountStatus: obj.account_status ?? null,
      message: "Token valid",
    };
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof MetaApiError) {
      // eslint-disable-next-line no-console
      console.error(
        `[health] Meta API error for ${account.slug}: code=${err.code} subcode=${err.subcode} http=${err.httpStatus} — ${err.message}`,
      );
      const body: HealthResponse = {
        ok: false,
        accountName: null,
        accountStatus: null,
        message:
          err.code === 190
            ? "Token invalid or expired (190) — re-issue the System User token"
            : `Meta API error (${err.code ?? "?"}): ${err.message}`,
      };
      // 200 with ok:false so the pill renders; the failure is in the payload.
      return NextResponse.json(body);
    }
    if (err instanceof LiveCredentialsError) {
      const body: HealthResponse = {
        ok: false,
        accountName: null,
        accountStatus: null,
        message: err.message,
      };
      return NextResponse.json(body);
    }
    const body: HealthResponse = {
      ok: false,
      accountName: null,
      accountStatus: null,
      message: err instanceof Error ? err.message : "Health check failed",
    };
    return NextResponse.json(body);
  }
}
