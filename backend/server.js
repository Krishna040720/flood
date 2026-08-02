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
const { runWatch } = require("./watcher");
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
// published. This backend never auto-generates or guesses numbers.
// ---------------------------------------------------------------------
const OFFICIAL_DATA_PATH = path.join(__dirname, "official-data.json");

function loadOfficialData() {
  try {
    return JSON.parse(fs.readFileSync(OFFICIAL_DATA_PATH, "utf8"));
  } catch (e) {
    console.error("Could not read official-data.json:", e.message);
    return null;
  }
}

// ---------------------------------------------------------------------
// GITHUB-BACKED LEDGER STORAGE (optional) — Render's free tier disk is
// ephemeral, so without this, ledger-log.jsonl resets on every redeploy
// or cold-start restart. If GITHUB_TOKEN/OWNER/REPO are set, the ledger
// log is pulled from and pushed to a GitHub repo instead — free forever,
// and every commit becomes a second, independent tamper-evidence trail
// on top of the hash chain itself.
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
const GH_ENABLED = Boolean(GH.owner && GH.repo && GH.token);
let ghSha = null; // tracks the last known commit sha, needed to push updates

async function bootLedger() {
  const data = loadOfficialData();
  const seedEntries = data && Array.isArray(data.ledger) ? data.ledger : [];

  if (!GH_ENABLED) {
    ledgerChain.seedIfEmpty(seedEntries);
    console.log("Ledger: local disk only (set GITHUB_OWNER/REPO/TOKEN for durable storage).");
    return;
  }

  try {
    const remote = await githubStore.pullFile(GH);
    if (remote) {
      ledgerChain.overwriteLogFileRaw(remote.content);
      ghSha = remote.sha;
      console.log(`Ledger: loaded ${ledgerChain.readLog().length} entries from GitHub.`);
    } else {
      // Repo has no ledger file yet — seed locally, then commit that as
      // the first version so future restarts have something to pull.
      ledgerChain.seedIfEmpty(seedEntries);
      const content = ledgerChain.readLogFileRaw();
      ghSha = await githubStore.pushFile({
        ...GH,
        content,
        message: `Seed ledger log (${ledgerChain.readLog().length} entries)`,
      });
      console.log("Ledger: seeded and pushed initial version to GitHub.");
    }
  } catch (e) {
    console.error("GitHub sync failed, falling back to local disk:", e.message);
    ledgerChain.seedIfEmpty(seedEntries);
  }
}

// Called by add-ledger-entry.js after a local append, so the GitHub copy
// stays in sync. Safe to call even when GitHub isn't configured — it's a
// no-op then.
async function pushLedgerToGitHub(commitMessage) {
  if (!GH_ENABLED) return false;
  const content = ledgerChain.readLogFileRaw();
  ghSha = await githubStore.pushFile({ ...GH, content, sha: ghSha, message: commitMessage });
  return true;
}

// Same idea, for official-data.json — so an approved total-figure update
// survives Render's ephemeral disk too, not just the ledger.
let ghDataSha = null;
const GH_DATA_PATH = process.env.GITHUB_DATA_PATH || "backend/official-data.json";
async function pushOfficialDataToGitHub(commitMessage) {
  if (!GH_ENABLED) return false;
  const content = fs.readFileSync(OFFICIAL_DATA_PATH, "utf8");
  if (ghDataSha === null) {
    const existing = await githubStore.pullFile({ ...GH, path: GH_DATA_PATH });
    ghDataSha = existing ? existing.sha : undefined;
  }
  ghDataSha = await githubStore.pushFile({
    ...GH,
    path: GH_DATA_PATH,
    content,
    sha: ghDataSha,
    message: commitMessage,
  });
  return true;
}

// ---------------------------------------------------------------------
// HOURLY WATCHER (opt-in) — checks news feeds for candidate donations or
// total-figure updates and queues them for review. It NEVER publishes on
// its own; see watcher.js and pendingStore.js for why. Requires
// ADMIN_TOKEN to be set, both to trigger runs on-demand and to
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
    ledgerStorage: GH_ENABLED ? "github" : "local-disk-only",
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
// This is where "found by the hourly watcher" becomes "published to the
// public ledger," and only by a human clicking approve.
// ---------------------------------------------------------------------

// Trigger a check of all feeds right now, instead of waiting for the
// hourly timer. Useful for testing sources.json changes.
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
      const entry = {
        donor,
        amountCr: Number(amountCr),
        date,
        status: "reported",
        src: candidate.sourceLink,
        srcName: overrides.srcName || candidate.sourceFeed,
      };
      const record = ledgerChain.appendEntry(entry);
      const pushed = await pushLedgerToGitHub(`Add ledger entry: ${donor} (₹${amountCr}Cr)`);
      pendingStore.removeCandidate(req.params.id);
      return res.json({ ok: true, published: "ledger", entry: record, githubSynced: pushed });
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
      const data = loadOfficialData();
      if (!data) return res.status(500).json({ error: "official-data.json unavailable" });
      data.officialTotalCr = Number(amountCr);
      data.officialTotalAsOf = date;
      data.officialSourceUrl = candidate.sourceLink;
      data.officialSourceName = overrides.srcName || candidate.sourceFeed;
      fs.writeFileSync(OFFICIAL_DATA_PATH, JSON.stringify(data, null, 2));
      const pushed = await pushOfficialDataToGitHub(`Update official total: ₹${amountCr}Cr as of ${date}`);
      pendingStore.removeCandidate(req.params.id);
      return res.json({ ok: true, published: "official-data.json", officialTotalCr: data.officialTotalCr, githubSynced: pushed });
    }

    return res.status(400).json({ error: `unknown candidate type: ${candidate.type}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// simple health check — useful once this is on Render
app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), ledgerStorage: GH_ENABLED ? "github" : "local-disk-only" })
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

module.exports = { pushLedgerToGitHub };
