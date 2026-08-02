# Assam Flood Relief Tracker — backend

Plain Express server. Serves the frontend and a read-only API for
official, hand-verified figures, plus a tamper-evident donor ledger.
No fake counters, no payment simulation, no paid services required.

## Run locally

```
cd backend
npm install
node server.js
```

Runs on `http://localhost:3000`. Health check: `GET /health`.

## What it serves

- The frontend (`index.html`) as static files, plus a catch-all fallback.
- `GET /api/donations` — official CMRF total, ledger, channel totals,
  field orgs, verified donate links, and computed freshness flags. Reads
  from `official-data.json` — **edit that file by hand** whenever a new
  figure gets publicly announced. This backend never invents, estimates,
  or scrapes numbers.
- `GET /api/ledger` — the donor ledger as a hash-chained log.
- `GET /api/ledger/verify` — recomputes every hash and reports whether
  the chain is intact, and exactly where it breaks if not.

## The ledger is tamper-evident, not just a list

Donor entries live in `backend/ledger-log.jsonl`, an append-only log
where each entry's hash depends on the one before it (see
`ledgerChain.js`). Silently editing a past entry — say, changing a
donor's amount after publishing — breaks the chain from that point on,
and `/api/ledger/verify` catches it immediately.

**Add new entries with the CLI script, never by hand-editing the log:**

```
node add-ledger-entry.js "Donor Name" 1.5 "01 Aug 2026" reported "https://source-url" "Source Name"
```

## Free durable ledger storage (no paid disk needed)

Render's free tier disk is ephemeral — files reset on every redeploy or
cold-start restart. Rather than pay for a persistent disk, this backend
can store the ledger log in a GitHub repo instead, for free, forever.
Bonus: every commit becomes a second, independent way for anyone to
verify the ledger's history wasn't quietly rewritten — checkable outside
this app entirely, in the repo's own commit log.

**Setup (~5 minutes):**

1. Create a GitHub repo (public or private — public makes the commit
   history itself a visible transparency artifact, which fits this
   project's purpose).
2. Generate a **fine-grained personal access token** at
   github.com/settings/tokens with **Contents: Read and write** scope,
   limited to that one repo.
3. Set these environment variables (in Render's dashboard, or a local
   `.env` — see `.env.example`):
   - `GITHUB_OWNER` — your GitHub username or org
   - `GITHUB_REPO` — the repo name
   - `GITHUB_TOKEN` — the token from step 2
4. Deploy. On first boot with no ledger file in the repo yet, the server
   seeds one from `official-data.json` and commits it. On every later
   boot, it pulls the latest version from GitHub first — so a redeploy
   no longer loses anything.
5. When you add entries with `add-ledger-entry.js`, it commits the
   update to GitHub automatically (if the env vars above are set).

**Not set up?** Nothing breaks — the app falls back to local-disk-only
storage automatically. You'll just lose manually-added entries (beyond
what's seeded from `official-data.json`) on the next redeploy, until you
configure this.

## Deploy to Render

1. Push this repo to Render.
2. New Web Service → root directory `backend` if it's a subfolder.
3. Build command: `npm install`. Start command: `node server.js`.
4. Add the `GITHUB_*` environment variables above if you want durable
   ledger storage (recommended, and free).
5. Render sets `PORT` automatically — the server already reads
   `process.env.PORT`.

## This app does not touch real money

No payment gateway keys, no bank details, nothing that moves funds. It
only displays publicly confirmed figures. Every "Donate" link on the
frontend sends people directly to a real, verified channel — currently
the official Assam CM's Relief Fund (`cm.assam.gov.in/donate`) and named
field NGOs — so real money moves through their own verified payment
infrastructure, not through this app.
