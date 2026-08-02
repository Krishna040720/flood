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

// Seed the hash-chained ledger log from official-data.json the first time
// the server runs on a fresh checkout. After that the log file is the
// source of truth for the ledger — add new entries with add-ledger-entry.js.
(function seedLedgerOnBoot() {
  const data = loadOfficialData();
  if (data && Array.isArray(data.ledger)) {
    ledgerChain.seedIfEmpty(data.ledger);
  }
})();

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
  // Ledger now comes from the verified hash chain, not the raw JSON array.
  const chain = ledgerChain.readLog();
  res.json({
    ...data,
    ledger: chain.length ? chain : data.ledger,
    freshness: computeFreshness(data),
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
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Fallback: any non-API GET request gets the frontend, so a hard refresh
// on a client-side route still loads the page instead of 404ing.
app.get(/^\/(?!api\/|health).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Assam flood relief backend listening on :${PORT}`);
});
