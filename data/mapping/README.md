# Store to Page mapping

Drop one CSV per ad account here, named by the account **slug** (see
[`config/accounts.ts`](../../config/accounts.ts)):

```
data/mapping/acme.csv
data/mapping/riverbend.csv
```

This file is the source of truth for two things per store: the Facebook **Page**
its ads publish from, and (optionally) the **landing page** each ad links to.

## Format

A header row is required. Two layouts are auto-detected by their headers, so use
whichever matches the data you already have.

**Layout A** — store code plus Page ID:

```csv
Campaign Name,Link Object ID,url
00123,o:100000000000001,https://www.example.com/stores/00123
00124,o:100000000000002,https://www.example.com/stores/00124
```

**Layout B** — store number plus Page ID, with optional notes:

```csv
store number,city_state,page_id,note,url
0012,Austin TX,100000000000001,,https://www.example.com/stores/0012
0034,Dallas TX,100000000000002,SHARED,https://www.example.com/stores/0034
```

### Columns

- **Store code** (`Campaign Name` in Layout A, `store number` in Layout B) — the
  code that identifies the store. Treated as **text**, so leading zeros are
  preserved (`00197` stays `00197`, not `197`). Whitespace and case are normalized
  when joining, so minor differences are fine.
- **Page ID** (`Link Object ID` in Layout A, `page_id` in Layout B) — the Facebook
  Page the store's ads publish from. In Layout A a leading `o:` prefix (e.g.
  `o:100000000000001`) is stripped down to the bare numeric Page ID.
- **url** *(optional)* — the per-store landing page. When a store has one, its
  created ad links there. Stores with a blank or missing `url` fall back to the
  single Destination URL you type in the Create modal. Accepted header names:
  `url`, `landing_page`, `landing_url`, or `destination`.

## What discovery does with it

For each account, Dupe:

1. Reads your CSV (the intended Page, and optional landing page, per store).
2. Reads each campaign's existing ads from the Meta API and extracts the actual
   Page from `creative.object_story_spec.page_id`.
3. Reconciles the two and flags every row (OK, MISMATCH, missing mapping, missing
   from the API) so you catch wrong or missing Page bindings before any ad is
   created.

Only `example.csv` (a non-sensitive template) and this README are tracked in git.
Your real per-account files are **git-ignored**, since they contain your data.
