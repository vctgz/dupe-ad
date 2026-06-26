// Per-route auth guard for API route handlers. When the optional login portal is
// enabled (AUTH_ENABLED=true), middleware.ts redirects unauthenticated *page*
// navigations to /login and this guards the JSON APIs. When it is off, the tool
// runs open and these helpers resolve the account from the request.
import "server-only";
import { cookies } from "next/headers";
import { AUTH_COOKIE, accountSlugFromCookieValue, authEnabled } from "@/lib/auth";
import { DEFAULT_ACCOUNT_SLUG } from "@/config/accounts";

/** The authenticated account slug for this request, or null. */
export function sessionAccountSlug(): string | null {
  const value = cookies().get(AUTH_COOKIE)?.value;
  return accountSlugFromCookieValue(value);
}

export function isRequestAuthed(): boolean {
  return sessionAccountSlug() !== null;
}

/** Result of authorizing the ad account a request may act on. */
export type AccountAuthz =
  | { ok: true; slug: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Resolve and authorize the ad account for a request.
 *  - Auth OFF (open self-host): use the requested account, else the default.
 *  - Auth ON: require a valid session AND that the requested account matches it,
 *    so a teammate signed in to one account can never reach another.
 * Routes still call getAccountBySlug() on the returned slug to confirm it exists.
 */
export function authorizeAccount(requested: string | null | undefined): AccountAuthz {
  const want = requested && requested.length > 0 ? requested : null;
  if (!authEnabled()) {
    return { ok: true, slug: want ?? DEFAULT_ACCOUNT_SLUG };
  }
  const session = sessionAccountSlug();
  if (!session) return { ok: false, status: 401, error: "Unauthorized" };
  const slug = want ?? session;
  if (slug !== session) {
    return {
      ok: false,
      status: 403,
      error: "This account is not permitted for the current session.",
    };
  }
  return { ok: true, slug };
}
