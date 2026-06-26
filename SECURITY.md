# Security Policy

## Important: Dupe runs open by default

Dupe runs open by default, with no login, on purpose, to keep self-hosting simple. It
creates real ads on your real Meta ad account. Anyone who can reach the running app
can use your Meta token.

Do not expose Dupe on the public internet without a gate in front of it. Pick one:

- Run it locally.
- Put it behind Vercel password protection.
- Put it behind Cloudflare Access (Zero Trust).
- Restrict it with an IP allowlist.

## The optional built-in login

Dupe ships an optional login portal (`AUTH_ENABLED=true`) that gives each ad account
its own password, and locks each login to a single account. It is handy for sharing
with a team.

Be aware of its limits. It uses one shared password per account, not per person. So
there is no per-person identity or audit trail. If you need to know exactly who did
what, or you want stronger guarantees, put Dupe behind SSO (for example Cloudflare
Access) or run a separate per-account deployment. The optional login does not replace
gating the app before you expose it publicly.

## Handling secrets

- Keep secrets in `.env.local` (which is gitignored) or your host's env store.
- Never commit real tokens.
- If a token leaks, rotate it in the Meta App dashboard right away.

## Dependencies

Dupe tracks the latest Next.js 14.2.x patch. Because the repo is public, you can run
`npm audit` yourself at any time to see the current status. Most reported Next.js
advisories target features Dupe does not use. If you self-host on a public, high-traffic
deployment, plan to move to the next major Next.js release when you can; for a gated or
local deployment the residual risk is low.

## Reporting a vulnerability

Please do not file public issues for sensitive reports.

To report a vulnerability, open a private security advisory on GitHub (Security tab >
Report a vulnerability), or email the maintainer. We will respond as quickly as we can
and keep you updated on a fix.

Thank you for helping keep Dupe and its users safe.
