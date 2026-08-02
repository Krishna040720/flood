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

// simple health check — useful once this is on Render
app.get("/health", (req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), ledgerStorage: GH_ENABLED ? "github" : "local-disk-only" })
);

// Fallback: any non-API GET request gets the frontend, so a hard refresh
// on a client-side route still loads the page instead of 404ing.
app.get(/^\/(?!api\/|health).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

(async function main() {
  await bootLedger();
  app.listen(PORT, () => {
    console.log(`Assam flood relief backend listening on :${PORT}`);
  });
})();

module.exports = { pushLedgerToGitHub };
