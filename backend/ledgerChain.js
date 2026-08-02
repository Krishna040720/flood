// ledgerChain.js
//
// A minimal hash-chained append-only log, same idea as a blockchain's core
// primitive (without the distributed/consensus part, which this single-
// server app doesn't need). Purpose: make silent edits to historical ledger
// entries detectable, not impossible — nobody with filesystem access can be
// fully stopped, but they CAN'T rewrite the past without the chain visibly
// breaking, which is the property that actually matters for a public
// transparency page.
//
// Each entry's hash = sha256(prevHash + canonical JSON of this entry's
// content). Change any past entry's content even slightly and every hash
// after it stops matching, which /api/ledger/verify will catch.

const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const LOG_PATH = path.join(__dirname, "ledger-log.jsonl");
const GENESIS_HASH = "0".repeat(64);

function canonicalize(entry) {
  // Stable key order so the same content always hashes the same way,
  // regardless of how the object literal was written.
  const { donor, amountCr, date, status, src, srcName } = entry;
  return JSON.stringify({ donor, amountCr, date, status, src, srcName });
}

function computeHash(prevHash, entry) {
  return crypto
    .createHash("sha256")
    .update(prevHash + canonicalize(entry))
    .digest("hex");
}

function readLog() {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs
    .readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Seed the log from official-data.json's ledger array the first time the
// server runs, if no log exists yet. After that, official-data.json's
// ledger array is ignored in favour of the log — new entries must go
// through appendEntry() (see add-ledger-entry.js) so the chain stays intact.
function seedIfEmpty(seedEntries) {
  if (fs.existsSync(LOG_PATH)) return;
  let prevHash = GENESIS_HASH;
  const lines = seedEntries.map((entry) => {
    const hash = computeHash(prevHash, entry);
    const record = { ...entry, prevHash, hash };
    prevHash = hash;
    return JSON.stringify(record);
  });
  fs.writeFileSync(LOG_PATH, lines.join("\n") + (lines.length ? "\n" : ""));
}

function appendEntry(entry) {
  const log = readLog();
  const prevHash = log.length ? log[log.length - 1].hash : GENESIS_HASH;
  const hash = computeHash(prevHash, entry);
  const record = { ...entry, prevHash, hash };
  fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
  return record;
}

// Recompute every hash from scratch and compare to what's stored. This is
// the actual tamper-evidence check: if anyone hand-edited a past line's
// donor/amount/date/etc without recomputing hashes correctly, this fails
// at the first broken link and says exactly where.
function verifyChain() {
  const log = readLog();
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < log.length; i++) {
    const record = log[i];
    if (record.prevHash !== prevHash) {
      return { valid: false, brokenAt: i, reason: "prevHash mismatch", length: log.length };
    }
    const recomputed = computeHash(prevHash, record);
    if (recomputed !== record.hash) {
      return { valid: false, brokenAt: i, reason: "content/hash mismatch", length: log.length };
    }
    prevHash = record.hash;
  }
  return { valid: true, length: log.length, headHash: prevHash };
}

function readLogFileRaw() {
  return fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, "utf8") : "";
}

function overwriteLogFileRaw(content) {
  fs.writeFileSync(LOG_PATH, content);
}

module.exports = {
  readLog,
  seedIfEmpty,
  appendEntry,
  verifyChain,
  computeHash,
  GENESIS_HASH,
  LOG_PATH,
  readLogFileRaw,
  overwriteLogFileRaw,
};
