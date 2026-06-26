// GET /api/accounts -> the list of switchable accounts (id, label, slug) + default.
import { NextResponse } from "next/server";
import { AD_ACCOUNTS, DEFAULT_ACCOUNT_SLUG } from "@/config/accounts";
import { sessionAccountSlug } from "@/lib/route-guard";
import { authEnabled } from "@/lib/auth";
import type { AccountsResponse, ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<AccountsResponse | ApiError>> {
  // Auth ON: scope to the signed-in account. Auth OFF: list all configured accounts.
  let accounts = AD_ACCOUNTS;
  let defaultSlug = DEFAULT_ACCOUNT_SLUG;
  const authed = authEnabled();
  if (authed) {
    const session = sessionAccountSlug();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    accounts = AD_ACCOUNTS.filter((a) => a.slug === session);
    // Never reveal another account's slug to a session locked to one account.
    defaultSlug = session;
  }
  const body: AccountsResponse = {
    accounts: accounts.map((a) => ({ id: a.id, label: a.label, slug: a.slug })),
    defaultSlug,
  };
  return NextResponse.json(body, {
    // Open mode: the list is static config, briefly cacheable per-browser. Auth mode:
    // the response is account-scoped, so never let any cache hold it.
    headers: { "Cache-Control": authed ? "private, no-store" : "private, max-age=300" },
  });
}
