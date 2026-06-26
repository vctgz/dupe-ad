# Contributing to Dupe

Thanks for taking the time to help out. Dupe is a small project and contributions are
genuinely appreciated.

## Run it locally

```bash
npm install
```

```bash
npm run dev
# open http://localhost:3000
```

You will need your Meta credentials in `.env.local` and at least one account in
`config/accounts.ts`. See the [README](README.md) for the full setup.

## Before you open a PR

Please run both of these and make sure they pass:

```bash
npm run typecheck
npm run lint
```

## A few asks

- Keep PRs focused. One change per PR is much easier to review.
- Write a short description of what you changed and why.
- Be kind in issues and reviews. We are all here to make a useful thing.

There is no CLA. Just open a pull request.
