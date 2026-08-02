// publisher.js
//
// The single place where a donor entry or an official-total update
// actually becomes public — appended to the hash chain / written to
// official-data.json, and synced to GitHub if configured. Both the
// manual admin-approval endpoint (server.js) and the trusted-source
// auto-publish path (watcher.js) call through here, so there's exactly
// one implementation of "what publishing means" — no risk of the two
// paths quietly drifting apart.

const fs = require("fs");
const path = require("path");
const ledgerChain = require("./ledgerChain");
const githubStore = require("./githubStore");

const OFFICIAL_DATA_PATH = path.join(__dirname, "official-data.json");
const GH_DATA_PATH = process.env.GITHUB_DATA_PATH || "backend/official-data.json";

const GH = {
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
  path: process.env.GITHUB_LEDGER_PATH || "backend/ledger-log.jsonl",
  branch: process.env.GITHUB_BRANCH || "main",
  token: process.env.GITHUB_TOKEN,
};
const GH_ENABLED = Boolean(GH.owner && GH.repo && GH.token);

let ghSha = null; // ledger file's last known commit sha
let ghDataSha = null; // official-data.json's last known commit sha

// Called once at boot (server.js's bootLedger) once it knows the ledger
// file's current sha from GitHub, so later pushes use the right sha
// instead of guessing / re-pulling every time.
function setLedgerSha(sha) {
  ghSha = sha;
}

async function pushLedgerToGitHub(commitMessage) {
  if (!GH_ENABLED) return false;
  const content = ledgerChain.readLogFileRaw();
  ghSha = await githubStore.pushFile({ ...GH, content, sha: ghSha, message: commitMessage });
  return true;
}

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

function loadOfficialData() {
  return JSON.parse(fs.readFileSync(OFFICIAL_DATA_PATH, "utf8"));
}

// Publishes one donor to the hash-chained public ledger.
async function publishDonorEntry({ donor, amountCr, date, src, srcName, status = "reported" }) {
  const entry = { donor, amountCr: Number(amountCr), date, status, src, srcName };
  const record = ledgerChain.appendEntry(entry);
  const githubSynced = await pushLedgerToGitHub(`Add ledger entry: ${donor} (₹${amountCr}Cr)`);
  return { record, githubSynced };
}

// Publishes a new official CMRF total to official-data.json.
async function publishTotalUpdate({ amountCr, date, src, srcName }) {
  const data = loadOfficialData();
  data.officialTotalCr = Number(amountCr);
  data.officialTotalAsOf = date;
  data.officialSourceUrl = src;
  data.officialSourceName = srcName;
  fs.writeFileSync(OFFICIAL_DATA_PATH, JSON.stringify(data, null, 2));
  const githubSynced = await pushOfficialDataToGitHub(`Update official total: ₹${amountCr}Cr as of ${date}`);
  return { officialTotalCr: data.officialTotalCr, githubSynced };
}

module.exports = {
  GH_ENABLED,
  OFFICIAL_DATA_PATH,
  setLedgerSha,
  pushLedgerToGitHub,
  pushOfficialDataToGitHub,
  loadOfficialData,
  publishDonorEntry,
  publishTotalUpdate,
};
