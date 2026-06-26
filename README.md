# Dupe

Bulk-duplicate Meta ads across all your Pages.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-14-black.svg)](https://nextjs.org/)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-d97757.svg)](https://claude.com/claude-code)

Dupe is a self-hostable web app that creates and duplicates Meta (Facebook and
Instagram) ads across many Facebook Pages at once. It is built for franchises,
multi-location brands, and agencies that run near-identical ads for a lot of stores
or locations, where each location publishes from its own Facebook Page.

You point Dupe at your Meta ad account, it lists your campaigns, you pick the stores
you want, and it creates one ad per Page. Every ad is created PAUSED, so nothing goes
live until you review it. Optional AI-written copy is one click away.

> Status: early but working. The from-scratch "Create" flow does live writes today.
> Live duplicate-mode cloning and multi-placement creatives are on the roadmap.

## How it works

1. Configure your ad account(s) in `config/accounts.ts` and your Meta credentials in
   `.env.local`.
2. Dupe reads your campaigns from the Meta Graph API. You get one row per campaign,
   with the Page each one publishes from.
3. Select the stores and campaigns you want. Fill in the creative (image, primary
   text, headline, link, call to action). Optionally click Generate Copy for an AI
   draft.
4. Dupe creates one paused ad per selected Page. You review and unpause in Meta Ads
   Manager.

## Quickstart

```bash
git clone https://github.com/vctgz/dupe-ad.git
cd dupe-ad
```

```bash
npm install
```

```bash
cp .env.example .env.local
# then fill it in (see Configuration below)
```

The repo ships with one **placeholder `Acme` account**. Replace it in
`config/accounts.ts` with your own (`id`, `label`, `slug`), or set the `ACCOUNTS_JSON`
env var instead (it wins when present, so your real account ids never touch the repo).

```bash
npm run dev
# open http://localhost:3000
```

## Configuration

### Ad accounts

Accounts live in `config/accounts.ts`, which ships with one placeholder example
(`Acme`) for you to replace. Add one row per ad account you want Dupe to work with.
Each account has:

| Field            | What it is                                                                        |
| ---------------- | --------------------------------------------------------------------------------- |
| `id`             | Numeric ad account id, no `act_` prefix.                                           |
| `label`          | Human-readable name shown in the UI.                                              |
| `slug`           | Url-safe key for the account.                                                      |
| `storeCodeDigits`| How many leading digits in a campaign name identify the store.                    |
| `tokenEnvVar`    | Optional. Name of a per-account token override env var.                           |

### Environment variables

Copy `.env.example` to `.env.local` and fill it in. These are the core variables Dupe
reads. The optional team login adds a few more (see [Team access](#team-access-optional)).

| Variable                  | Required | What it is                                                                                   |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `META_GRAPH_VERSION`      | no       | Pinned Meta Graph API version. Defaults to `v23.0`.                                           |
| `META_APP_ID`             | yes      | Meta App ID (App Dashboard, Settings > Basic).                                                |
| `META_APP_SECRET`         | yes      | Meta App secret (App Dashboard, Settings > Basic).                                            |
| `META_SYSTEM_USER_TOKEN`  | yes      | Access token with `ads_management`. A long-lived System User token is ideal.                 |
| `META_TOKEN_<SLUG>`       | no       | Per-account token override, e.g. `META_TOKEN_ACME`. Falls back to `META_SYSTEM_USER_TOKEN`.  |
| `TEMPLATE_AD_NAME`        | no       | The ad name Dupe treats as each campaign's template. Defaults to `Template`.                  |
| `ACCOUNTS_JSON`           | no       | JSON array of account configs. Overrides `config/accounts.ts` when set, so real account ids never touch the repo. |
| `DISCOVERY_SOURCE`        | no       | `auto` (default), `snapshot`, `live`, or `mapping`. Forces which data source discovery reads from. |
| `ANTHROPIC_API_KEY`       | no       | Powers the Generate Copy button. Without it, Generate Copy returns 503 and everything else works fine. |
| `ANTHROPIC_COPY_MODEL`    | no       | Model used for Generate Copy. Defaults to `claude-sonnet-4-6`.                                |

A note on the token: its identity must have access to BOTH the ad account AND every
Facebook Page you publish from. Otherwise page-bound ad creation fails. A normal User
token works too, as long as you administer the Pages.

## Security

Please read this before you deploy.

Dupe runs open by default, with no login. That is on purpose, to keep self-hosting
simple, and it is what most self-hosters want. But it creates real ads on your real
ad account. Anyone who can reach the running app can use your Meta token.

So do not expose Dupe on the public internet without a gate in front of it. Pick one:

- Run it locally.
- Put it behind Vercel password protection.
- Put it behind Cloudflare Access (Zero Trust).
- Restrict it with an IP allowlist.

There is also an optional built-in login (see Team access below), but it does not
replace gating the app before you expose it publicly.

Secrets live in `.env.local` (which is gitignored) or your host's env store. Never
commit real tokens. See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Team access (optional)

Dupe runs open by default, no login. That suits most self-hosters.

If you want to share Dupe with a team, flip on the built-in login portal. Set
`AUTH_ENABLED=true` to require a login. Then give each ad account its own password
with an `APP_PASSWORD_<SLUG>` env var, wired to that account through the
`passwordEnvVar` field in `config/accounts.ts`.

Each login is scoped to a single account. A teammate who signs in with an account's
password is locked to that one account and sees nothing else. Hand a coworker the
Acme password and they only ever see and act on Acme.

When `AUTH_ENABLED` is true in production, also set `APP_SESSION_SECRET` so sessions
are signed. Generate one with:

```bash
openssl rand -hex 32
```

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/vctgz/dupe-ad)

After deploying:

1. Set the same env vars from the table above in your Vercel project settings.
2. Gate access to the app (see Security). Do not skip this.

`NODE_ENV=production` is set automatically on Vercel, so there is nothing to do there.

## Scripts

```bash
npm run dev        # start the dev server
npm run build      # production build
npm run start      # serve the production build
npm run typecheck  # tsc --noEmit
npm run lint       # next lint
```

## Roadmap

- Video ad creatives (an Image or Video choice in the creator), with resumable
  upload and an auto-captured thumbnail.
- Live duplicate-mode cloning.
- Multi-placement (Story and Reels) creatives.
- An in-app account switcher.
- An optional auth provider.
- Snapshot and offline mode.

## Tech

Next.js 14 (App Router, TypeScript) and Tailwind CSS. It calls the Meta Marketing API
server-side. No database. Every ad is created PAUSED.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Dupe was vibe-coded by [Victor Gonzalez](https://github.com/vctgz) with a lot of help from Claude (Anthropic) in VS Code with [Claude Code](https://claude.com/claude-code) riding shotgun.

## License

MIT. See [LICENSE](LICENSE).