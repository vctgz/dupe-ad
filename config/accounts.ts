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
import { z } from "zod";

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

// Validates one ACCOUNTS_JSON entry. Lenient where the legacy loader coerced (a numeric
// id or storeCodeDigits may arrive as a JSON string) but rejects genuine garbage like
// `[{}]`, which previously became an account with id/label/slug all "undefined".
const accountSchema = z.object({
  id: z.coerce.string().regex(/^\d+$/, "id must be a numeric ad account id (no act_ prefix)"),
  label: z.string().trim().min(1, "label is required"),
  // Restrict to lowercase letters, digits, hyphens so the slug->MAPPING_<SLUG> /
  // APP_PASSWORD_<SLUG> env-var derivation stays 1:1 (no two slugs collide on one var).
  slug: z.string().trim().regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, digits, and hyphens"),
  storeCodeDigits: z.coerce.number().int("storeCodeDigits must be an integer").min(1).max(15),
  tokenEnvVar: z.string().trim().min(1).optional(),
  passwordEnvVar: z.string().trim().min(1).optional(),
});

/** Load accounts from ACCOUNTS_JSON when set, else the shipped examples. */
function loadAccounts(): AdAccount[] {
  const raw = process.env.ACCOUNTS_JSON;
  if (raw && raw.trim().length > 0) {
    try {
      const parsed = z
        .array(accountSchema)
        .min(1, "ACCOUNTS_JSON must be a non-empty array")
        .parse(JSON.parse(raw));
      return parsed.map((a) => ({
        id: a.id,
        label: a.label,
        slug: a.slug,
        storeCodeDigits: a.storeCodeDigits,
        tokenEnvVar: a.tokenEnvVar,
        passwordEnvVar: a.passwordEnvVar,
      }));
    } catch (err) {
      // In production a malformed override is a deploy error: fail loudly rather than
      // silently serving the placeholder account. In dev, fall back to the examples.
      if (process.env.NODE_ENV === "production") {
        const detail =
          err instanceof z.ZodError
            ? err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
            : err instanceof Error
              ? err.message
              : String(err);
        throw new Error(`Invalid ACCOUNTS_JSON: ${detail}`);
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
