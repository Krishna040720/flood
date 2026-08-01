# Assam Flood Relief Tracker — backend

Express + Socket.io, same stack you're already using for together-app.

## Run locally

```
cd backend
npm install
node server.js
```

Runs on `http://localhost:3000`. Health check: `GET /health`.

## What it serves

- `GET /api/donations` — official CMRF total, ledger, channel totals, field
  orgs, donate options. Reads from `official-data.json`. **Edit that file by
  hand** when a new figure gets published — this backend never invents or
  scrapes numbers.
- `GET /api/community` — all self-reported "I donated ₹X elsewhere" entries.
- `POST /api/community` — add one (`{ amount, name, where }`), broadcasts
  instantly to every connected browser tab via Socket.io (`community:new`).
- Socket.io `community:snapshot` — sent once per connection so a fresh tab
  isn't empty while waiting for the next live entry.

## Deploy to Render (same pattern as together-app)

1. Push this `backend/` folder to a repo (or a subfolder of your existing
   together-app repo).
2. New Web Service on Render → point at the repo → root directory `backend`
   if it's a subfolder.
3. Build command: `npm install`. Start command: `node server.js`.
4. Render sets `PORT` automatically — the server already reads
   `process.env.PORT`.
5. Once deployed, copy the Render URL into the frontend's `API_URL`
   constant (same dynamic localhost/production switch pattern you already
   use).

## Persistence note (read before the actual hackathon demo)

Community donations are kept in memory and mirrored to
`community-donations.json` on disk. On Render's free tier, the disk is
**not guaranteed to survive a redeploy or restart** — fine for a live demo
session, not fine as permanent storage. Before any real launch, swap
`loadCommunity`/`saveCommunity` in `server.js` for a real database (Postgres
or MongoDB Atlas free tier both drop in cleanly against this same API
shape).

## This backend does not touch real money

No payment gateway keys, no bank details, nothing that moves funds. It only
serves published figures and logs self-reported pledges. See the "Path to
handling real funds" section on the frontend for what would need to change
before that's true.
