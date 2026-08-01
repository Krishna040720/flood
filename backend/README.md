# Assam Flood Relief Tracker — backend

Plain Express server. Serves the frontend and one read-only API for
official, hand-verified figures. No fake counters, no payment simulation.

## Run locally

```
cd backend
npm install
node server.js
```

Runs on `http://localhost:3000`. Health check: `GET /health`.

## What it serves

- The frontend (`index.html`) as static files, plus a catch-all fallback
  so any path serves the page instead of a 404.
- `GET /api/donations` — official CMRF total, ledger, channel totals, field
  orgs, and verified donate links. Reads from `official-data.json`. **Edit
  that file by hand** whenever a new figure gets publicly announced — this
  backend never invents, estimates, or scrapes numbers.

## Deploy to Render

1. Push this repo (or push `backend/` as a subfolder) to Render.
2. New Web Service → point at the repo → root directory `backend` if it's
   a subfolder.
3. Build command: `npm install`. Start command: `node server.js`.
4. Render sets `PORT` automatically — the server already reads
   `process.env.PORT`.

## This app does not touch real money

No payment gateway keys, no bank details, nothing that moves funds. It
only displays publicly confirmed figures. Every "Donate" link on the
frontend sends people directly to a real, verified channel — currently
the official Assam CM's Relief Fund (`cm.assam.gov.in/donate`) and named
field NGOs — so real money moves through their own verified payment
infrastructure, not through this app.

See the "Path to handling real funds" section on the frontend for what
would actually need to change (legal entity registration, 80G, FCRA,
or an NGO partnership) before this app itself could custody donations.
