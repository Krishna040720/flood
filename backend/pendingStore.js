// pendingStore.js
//
// Holds candidate donor-ledger entries and total-figure updates that the
// watcher (watcher.js) has found but NOT yet published. Nothing here ever
// touches the public ledger or official-data.json on its own — a human
// has to call approve() (via the /api/admin/pending endpoints) first.
//
// This is the review gate: it's what keeps "hourly auto-updates" from
// turning into "hourly auto-publish of unverified financial claims."

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PENDING_PATH = path.join(__dirname, "pending-entries.json");

function readPending() {
  if (!fs.existsSync(PENDING_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(PENDING_PATH, "utf8"));
  } catch (e) {
    console.error("pending-entries.json unreadable, treating as empty:", e.message);
    return [];
  }
}

function writePending(list) {
  fs.writeFileSync(PENDING_PATH, JSON.stringify(list, null, 2));
}

// De-duplicates by source link, so the same article found on a later run
// doesn't create a second candidate.
function addCandidate(candidate) {
  const list = readPending();
  const exists = list.some((c) => c.sourceLink === candidate.sourceLink);
  if (exists) return null;
  const record = {
    id: crypto.randomBytes(6).toString("hex"),
    foundAt: new Date().toISOString(),
    ...candidate,
  };
  list.push(record);
  writePending(list);
  return record;
}

function removeCandidate(id) {
  const list = readPending();
  const next = list.filter((c) => c.id !== id);
  writePending(next);
  return next.length !== list.length;
}

function getCandidate(id) {
  return readPending().find((c) => c.id === id) || null;
}

module.exports = { readPending, addCandidate, removeCandidate, getCandidate };
