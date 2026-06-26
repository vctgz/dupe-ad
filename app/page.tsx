// Root entry (server component). Canonicalizes to the path-based account route
// /<slug> (the real dashboard lives in app/[account]/page.tsx). This keeps the bare
// "/" URL and the legacy "?account=<slug>" form working while standardizing on the
// path. The Meta token never reaches this layer; there is no account switching (the
// client logs in as their account).
import { redirect } from "next/navigation";
import { getAccountBySlug, DEFAULT_ACCOUNT_SLUG } from "@/config/accounts";
import { sessionAccountSlug } from "@/lib/route-guard";
import { authEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function RootPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined };
}) {
  // Auth ON: require a signed-in account, locked to the session, and send the user
  // to that account's path. Auth OFF (open self-host): honor legacy ?account=<slug>,
  // else fall back to the configured default account.
  if (authEnabled()) {
    const session = sessionAccountSlug();
    if (!session) redirect("/login");
    redirect(`/${session}`);
  }

  const requested = typeof searchParams.account === "string" ? searchParams.account : "";
  const slug = getAccountBySlug(requested) ? requested : DEFAULT_ACCOUNT_SLUG;
  redirect(`/${slug}`);
}
