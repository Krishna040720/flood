// Assam Flood Relief Tracker — backend
//
// Two jobs:
// 1. Serve the "official" side of the page (CMRF total, ledger, NGO channel
//    totals, field orgs) from a small config file you edit by hand as new
//    figures get published. This backend does NOT scrape or invent numbers.
// 2. Run the "community self-reported" counter: anyone can log a donation
//    they made elsewhere, it's broadcast live over Socket.io to every open
//    tab, and kept in memory (see NOTE on persistence below).
//
// This never touches real payment rails. No payment gateway keys live here.
// It only stores what people say they gave, clearly labelled as unverified.

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors()); // for the hackathon demo this is wide open; tighten to your frontend's origin before a real deploy
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------
// 1. OFFICIAL DATA — edit official-data.json by hand as real figures
//    change. This backend never auto-generates or guesses these numbers.
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

// ---------------------------------------------------------------------
// 2. COMMUNITY SELF-REPORTED DONATIONS
//
// NOTE ON PERSISTENCE: this keeps entries in memory plus a local JSON
// file for restarts during dev. On a free Render instance the disk is
// NOT guaranteed to persist across deploys/restarts. For the hackathon
// demo this is fine — entries survive a normal running session. Before
// a real launch, swap this for a proper database (Postgres/Mongo Atlas
// free tier both work fine with this same API shape).
// ---------------------------------------------------------------------
const COMMUNITY_PATH = path.join(__dirname, "community-donations.json");

function loadCommunity() {
  try {
    return JSON.parse(fs.readFileSync(COMMUNITY_PATH, "utf8"));
  } catch (e) {
    return [];
  }
}

function saveCommunity(entries) {
  try {
    fs.writeFileSync(COMMUNITY_PATH, JSON.stringify(entries, null, 2));
  } catch (e) {
    console.error("Could not persist community donations:", e.message);
  }
}

let communityDonations = loadCommunity();

app.get("/api/community", (req, res) => {
  res.json(communityDonations);
});

app.post("/api/community", (req, res) => {
  const { amount, name, where } = req.body || {};
  const amt = Number(amount);

  if (!amt || amt <= 0 || amt > 10000000) {
    return res.status(400).json({ error: "Enter a valid amount (₹1 to ₹1,00,00,000)." });
  }

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    amount: amt,
    name: String(name || "").trim().slice(0, 40),
    where: String(where || "").trim().slice(0, 60),
    ts: Date.now(),
  };

  communityDonations.push(entry);
  saveCommunity(communityDonations);

  io.emit("community:new", entry); // push to every connected client instantly

  res.status(201).json(entry);
});

// simple health check — useful once this is on Render
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

io.on("connection", (socket) => {
  // Send the current list once on connect so a fresh tab isn't empty
  // until the next donation comes in.
  socket.emit("community:snapshot", communityDonations);
});

server.listen(PORT, () => {
  console.log(`Assam flood relief backend listening on :${PORT}`);
});
