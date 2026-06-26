// Path-based account routing: /<account> renders the dashboard for that account.
//
// Mirrors app/page.tsx but takes the account slug from the URL path instead of
// ?account=. Both modes are preserved:
//  - OPEN self-host (AUTH_ENABLED unset/false): the path segment selects the
//    account. Unknown slug -> 404 (notFound) so it doesn't silently show the
//    default account under the wrong URL.
//  - AUTH (AUTH_ENABLED=true): the session is locked to one account. We require a
//    session (else /login) and enforce that the path slug matches it, so a session
//    locked to account A can never reach /<B> (cross-account isolation, the same
//    guarantee authorizeAccount() gives the APIs). Mismatch -> redirect to the
//    session's own dashboard.
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { getAccountBySlug } from "@/config/accounts";
import { sessionAccountSlug } from "@/lib/route-guard";
import { authEnabled } from "@/lib/auth";
import Dashboard from "@/components/Dashboard";
import type { AccountInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

export default function AccountDashboardPage({
  params,
}: {
  params: { account: string };
}) {
  const requested = params.account;

  if (authEnabled()) {
    const session = sessionAccountSlug();
    if (!session) redirect("/login");
    // Cross-account guard: the path must match the locked session account.
    if (requested !== session) redirect(`/${session}`);
  } else {
    // Open mode: the path slug must name a real account.
    if (!getAccountBySlug(requested)) notFound();
  }

  const account = getAccountBySlug(requested);
  if (!account) {
    if (authEnabled()) redirect("/login");
    notFound();
  }

  const accountInfo: AccountInfo = {
    id: account.id,
    label: account.label,
    slug: account.slug,
  };

  return (
    <Suspense
      fallback={
        <main className="mx-auto max-w-6xl bg-void p-6 text-fas-13 text-ink-muted">Loading…</main>
      }
    >
      <Dashboard account={accountInfo} authEnabled={authEnabled()} />
    </Suspense>
  );
}
