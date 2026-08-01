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
// OFFICIAL DATA — edit official-data.json by hand as real figures change.
// This backend never auto-generates or guesses these numbers.
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

app.get("/api/donations", (req, res) => {
  const data = loadOfficialData();
  if (!data) return res.status(500).json({ error: "official data unavailable" });
  res.json(data);
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
