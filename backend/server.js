// Assam Flood Relief Tracker — backend
//
// One job: serve the "official" side of the page (CMRF total, ledger, NGO
// channel totals, field orgs) from a small config file you edit by hand as
// new figures get published. This backend does NOT scrape or invent numbers,
// does not process payments, and does not custody or move any money.
//
// Real donations happen off this site entirely, at the verified links in
// official-data.json (e.g. cm.assam.gov.in/donate) — this app only tracks
// and displays publicly confirmed figures about them.

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const ledgerChain = require("./ledgerChain");
const githubStore = require("./githubStore");
const publisher = require("./publisher");
const { runWatch, readAutoPublishedLog } = require("./watcher");
const pendingStore = require("./pendingStore");

const app = express();
app.use(cors()); // for the hackathon demo this is wide open; tighten to your frontend's origin before a real deploy
app.use(express.json());

// ---------------------------------------------------------------------
// Serve the frontend. index.html lives one level up from /backend, at
// the project root, so we point static serving there.
// ---------------------------------------------------------------------
const FRONTEND_DIR = path.join(__dirname, "..");
app.use(express.static(FRONTEND_DIR));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------
// OFFICIAL DATA — edit official-data.json by hand as new figures get
// published (or let the watcher/publisher do it — see below). This
// backend never auto-generates or guesses numbers out of thin air.
// ---------------------------------------------------------------------
function loadOfficialData() {
  try {
    return publisher.loadOfficialData();
  } catch (e) {
    console.error("Could not read official-data.json:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// GITHUB-BACKED LEDGER STORAGE (optional) — Render's free tier disk is
// ephemeral, so without this, ledger-log.jsonl resets on every redeploy
// or cold-start restart. If GITHUB_TOKEN/OWNER/REPO are set (see
// publisher.js), the ledger log is pulled from and pushed to a GitHub
// repo instead — free forever, and every commit becomes a second,
// independent tamper-evidence trail on top of the hash chain itself.
//
// Not configured? The app falls back to local-disk-only storage
// automatically — nothing breaks, you just lose entries on redeploy
// until you set these.
// ---------------------------------------------------------------------
const GH = {
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
  path: process.env.GITHUB_LEDGER_PATH || "backend/ledger-log.jsonl",
  branch: process.env.GITHUB_BRANCH || "main",
  token: process.env.GITHUB_TOKEN,
};

async function bootLedger() {
  const data = loadOfficialData();
  const seedEntries = data && Array.isArray(data.ledger) ? data.ledger : [];

  if (!publisher.GH_ENABLED) {
    ledgerChain.seedIfEmpty(seedEntries);
    console.log("Ledger: local disk only (set GITHUB_OWNER/REPO/TOKEN for durable storage).");
    return;
  }

  try {
    const remote = await githubStore.pullFile(GH);
    if (remote) {
      ledgerChain.overwriteLogFileRaw(remote.content);
      publisher.setLedgerSha(remote.sha);
      console.log(`Ledger: loaded ${ledgerChain.readLog().length} entries from GitHub.`);
    } else {
      // Repo has no ledger file yet — seed locally, then commit that as
      // the first version so future restarts have something to pull.
      ledgerChain.seedIfEmpty(seedEntries);
      const content = ledgerChain.readLogFileRaw();
      const sha = await githubStore.pushFile({
        ...GH,
        content,
        message: `Seed ledger log (${ledgerChain.readLog().length} entries)`,
      });
      publisher.setLedgerSha(sha);
      console.log("Ledger: seeded and pushed initial version to GitHub.");
    }
  } catch (e) {
    console.error("GitHub sync failed, falling back to local disk:", e.message);
    ledgerChain.seedIfEmpty(seedEntries);
  }
}

// ---------------------------------------------------------------------
// HOURLY WATCHER (opt-in) — checks news feeds for candidate donations or
// total-figure updates. Trusted sources (trusted-sources.json) publish
// automatically through publisher.js; everything else queues in
// pending-entries.json for a human to review. See watcher.js and
// README.md's "why this isn't fully automatic" section for the reasoning.
// Requires ADMIN_TOKEN to be set, both to trigger runs on-demand and to
// review/approve/reject candidates, since this touches what eventually
// becomes a public, hash-chained financial ledger.
// ---------------------------------------------------------------------
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "ADMIN_TOKEN not configured on the server — admin endpoints disabled." });
  }
  const supplied = req.get("x-admin-token") || req.query.token;
  if (supplied !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "invalid or missing admin token" });
  }
  next();
}

// ---------------------------------------------------------------------
// FRESHNESS — flag data as possibly stale instead of silently letting a
// number from days ago look as current as one from this morning.
// ---------------------------------------------------------------------
const STALE_DAYS = Number(process.env.STALE_DAYS || 5);

function daysOld(dateStr) {
  const parsed = new Date(dateStr);
  if (isNaN(parsed.getTime())) return null;
  const diffMs = Date.now() - parsed.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function freshnessFor(dateStr) {
  const age = daysOld(dateStr);
  if (age === null) return { asOf: dateStr, daysOld: null, stale: false, note: "date unparsed" };
  return { asOf: dateStr, daysOld: age, stale: age > STALE_DAYS };
}

function computeFreshness(data) {
  const chain = ledgerChain.readLog();
  const latestLedgerEntry = chain.length ? chain[chain.length - 1] : null;
  return {
    staleThresholdDays: STALE_DAYS,
    officialTotal: freshnessFor(data.officialTotalAsOf),
    channelTotals: (data.channelTotals || []).map((c) => ({
      name: c.name,
      ...freshnessFor(c.asOf),
    })),
    ledger: latestLedgerEntry
      ? { name: "Most recent ledger entry", ...freshnessFor(latestLedgerEntry.date) }
      : { name: "Most recent ledger entry", asOf: null, daysOld: null, stale: false },
  };
}

app.get("/api/donations", (req, res) => {
  const data = loadOfficialData();
  if (!data) return res.status(500).json({ error: "official data unavailable" });
  const chain = ledgerChain.readLog();
  res.json({
    ...data,
    ledger: chain.length ? chain : data.ledger,
    freshness: computeFreshness(data),
    ledgerStorage: publisher.GH_ENABLED ? "github" : "local-disk-only",
  });
});

// ---------------------------------------------------------------------
// TAMPER-EVIDENT LEDGER — recompute every hash in the chain and report
// exactly where it breaks, if it breaks. This is the actual integrity
// check a "verified ✓" badge on the frontend is backed by.
// ---------------------------------------------------------------------
app.get("/api/ledger/verify", (req, res) => {
  res.json(ledgerChain.verifyChain());
});

app.get("/api/ledger", (req, res) => {
  res.json(ledgerChain.readLog());
});

// ---------------------------------------------------------------------
// Admin endpoints — all require the x-admin-token header (or ?token=).
// ---------------------------------------------------------------------

// Trigger a check of all feeds right now, instead of waiting for the
// hourly timer. Trusted-source hits publish immediately; everything else
// lands in the pending queue below. Useful for testing sources.json /
// trusted-sources.json changes.
app.post("/api/admin/watch/run", requireAdmin, async (req, res) => {
  try {
    const result = await runWatch();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List everything currently awaiting human review.
app.get("/api/admin/pending", requireAdmin, (req, res) => {
  res.json(pendingStore.readPending());
});

// Audit trail of everything the trusted-source path published without
// review — so "automatic" never means "invisible."
app.get("/api/admin/auto-published", requireAdmin, (req, res) => {
  res.json(readAutoPublishedLog());
});

// Reject a candidate — removes it without publishing anything.
app.delete("/api/admin/pending/:id", requireAdmin, (req, res) => {
  const removed = pendingStore.removeCandidate(req.params.id);
  if (!removed) return res.status(404).json({ error: "candidate not found" });
  res.json({ ok: true });
});

// Approve a candidate — publishes it to the real ledger (donor_entry) or
// updates official-data.json (total_update). You can override any
// suggested field by passing it in the request body, since the watcher's
// extraction is a best-effort guess, not a claim of accuracy.
app.post("/api/admin/pending/:id/approve", requireAdmin, async (req, res) => {
  const candidate = pendingStore.getCandidate(req.params.id);
  if (!candidate) return res.status(404).json({ error: "candidate not found" });

  const overrides = req.body || {};

  try {
    if (candidate.type === "donor_entry") {
      const donor = overrides.donor || candidate.suggested.donor;
      const amountCr = overrides.amountCr ?? candidate.suggested.amountCr;
      const date = overrides.date || candidate.suggested.date;
      if (!donor || !amountCr || !date) {
        return res.status(400).json({
          error: "donor, amountCr, and date are required — the watcher's guess was incomplete, supply the missing field(s) in the request body",
          suggested: candidate.suggested,
        });
      }
      const { record, githubSynced } = await publisher.publishDonorEntry({
        donor,
        amountCr,
        date,
        src: candidate.sourceLink,
        srcName: overrides.srcName || candidate.sourceFeed,
      });
      pendingStore.removeCandidate(req.params.id);
      return res.json({ ok: true, published: "ledger", entry: record, githubSynced });
    }

    if (candidate.type === "total_update") {
      const amountCr = overrides.amountCr ?? candidate.suggested.amountCr;
      const date = overrides.date || candidate.suggested.date;
      if (!amountCr || !date) {
        return res.status(400).json({
          error: "amountCr and date are required — supply the missing field(s) in the request body",
          suggested: candidate.suggested,
        });
      }
      const result = await publisher.publishTotalUpdate({
        amountCr,
        date,
        src: candidate.sourceLink,
        srcName: overrides.srcName || candidate.sourceFeed,
      });
      pendingStore.removeCandidate(req.params.id);
      return res.json({ ok: true, published: "official-data.json", ...result });
    }

    return res.status(400).json({ error: `unknown candidate type: ${candidate.type}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// simple health check — useful once this is on Render
app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), ledgerStorage: publisher.GH_ENABLED ? "github" : "local-disk-only" })
);

// Fallback: any non-API GET request gets the frontend, so a hard refresh
// on a client-side route still loads the page instead of 404ing.
app.get(/^\/(?!api\/|health).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

const WATCH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

(async function main() {
  await bootLedger();
  app.listen(PORT, () => {
    console.log(`Assam flood relief backend listening on :${PORT}`);
  });

  if (ADMIN_TOKEN) {
    // Note: Render's free tier spins the instance down after ~15 min of
    // inactivity, and this timer only runs while the instance is awake.
    // For a truly reliable hourly cadence on the free tier, use an
    // external pinger (cron-job.org, UptimeRobot, etc.) hitting
    // POST /api/admin/watch/run every hour instead of relying on this.
    console.log("watcher: hourly timer started (in-process — see note about free-tier sleep in README).");
    setInterval(() => {
      runWatch().catch((e) => console.error("watcher: scheduled run failed:", e.message));
    }, WATCH_INTERVAL_MS);
  } else {
    console.log("watcher: ADMIN_TOKEN not set — hourly watcher disabled. See README to enable.");
  }
})();
