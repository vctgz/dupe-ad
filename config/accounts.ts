// Ad accounts Dupe can work with.
//
// Configure your own either by editing the EXAMPLE_ACCOUNTS array below, OR by
// setting the ACCOUNTS_JSON env var (an array of the same shape). ACCOUNTS_JSON
// wins when present, so you can configure real account ids without committing them.
//
// `id`              numeric ad account id WITHOUT the `act_` prefix
// `label`           human-readable name shown in the UI
// `slug`            url-safe key for the account (used in ?account=<slug>)
// `storeCodeDigits` how many leading digits in a campaign name identify the store
//                   (the join key against your store mapping), e.g. "0033 - ..." is 4
// `tokenEnvVar`     optional per-account token env var; falls back to META_SYSTEM_USER_TOKEN
// `passwordEnvVar`  optional; only used when AUTH_ENABLED=true (the login portal)

export type AdAccount = {
  id: string;
  label: string;
  slug: string;
  storeCodeDigits: number;
  tokenEnvVar?: string;
  passwordEnvVar?: string;
};

// Example shipped with the repo. Replace with your own, or use ACCOUNTS_JSON.
const EXAMPLE_ACCOUNTS: AdAccount[] = [
  {
    id: "1234567890",
    label: "Acme",
    slug: "acme",
    storeCodeDigits: 4,
    tokenEnvVar: "META_TOKEN_ACME",
    passwordEnvVar: "APP_PASSWORD_ACME",
  },
];

/** Load accounts from ACCOUNTS_JSON when set, else the shipped examples. */
function loadAccounts(): AdAccount[] {
  const raw = process.env.ACCOUNTS_JSON;
  if (raw && raw.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((a) => {
          const o = a as Record<string, unknown>;
          return {
            id: String(o.id),
            label: String(o.label),
            slug: String(o.slug),
            storeCodeDigits: Number(o.storeCodeDigits) || 0,
            tokenEnvVar: o.tokenEnvVar ? String(o.tokenEnvVar) : undefined,
            passwordEnvVar: o.passwordEnvVar ? String(o.passwordEnvVar) : undefined,
          };
        });
      }
      throw new Error("ACCOUNTS_JSON must be a non-empty array.");
    } catch (err) {
      // In production a malformed override is a deploy error: fail loudly rather than
      // silently serving the placeholder account. In dev, fall back to the examples.
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          `Invalid ACCOUNTS_JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  return EXAMPLE_ACCOUNTS;
}

export const AD_ACCOUNTS: AdAccount[] = loadAccounts();

// Shown by default in open mode, and the fallback account for unscoped requests.
export const DEFAULT_ACCOUNT_SLUG = AD_ACCOUNTS[0]?.slug ?? "acme";

export function getAccountBySlug(slug: string): AdAccount | undefined {
  return AD_ACCOUNTS.find((a) => a.slug === slug);
}
