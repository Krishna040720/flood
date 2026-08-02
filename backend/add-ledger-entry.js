// add-ledger-entry.js
//
// Run this whenever a new donation gets reported, instead of hand-editing
// ledger-log.jsonl. It appends correctly to the hash chain, and if
// GITHUB_OWNER/REPO/TOKEN are set, also commits the update to GitHub so it
// survives Render redeploys.
//
// Usage:
//   node add-ledger-entry.js "Donor Name" 1.5 "01 Aug 2026" reported "https://source-url" "Source Name"

const { appendEntry } = require("./ledgerChain");
const githubStore = require("./githubStore");

const [donor, amountCr, date, status, src, srcName] = process.argv.slice(2);

if (!donor || !amountCr || !date || !status || !src || !srcName) {
  console.error(
    'Usage: node add-ledger-entry.js "Donor Name" <amountCr> "DD Mon YYYY" <status> "<source url>" "Source Name"'
  );
  process.exit(1);
}

const record = appendEntry({
  donor,
  amountCr: Number(amountCr),
  date,
  status,
  src,
  srcName,
});

console.log("Appended and chained locally:");
console.log(record);

const GH = {
  owner: process.env.GITHUB_OWNER,
  repo: process.env.GITHUB_REPO,
  path: process.env.GITHUB_LEDGER_PATH || "backend/ledger-log.jsonl",
  branch: process.env.GITHUB_BRANCH || "main",
  token: process.env.GITHUB_TOKEN,
};

async function syncToGitHub() {
  if (!(GH.owner && GH.repo && GH.token)) {
    console.log("GITHUB_OWNER/REPO/TOKEN not set — skipping GitHub sync (local-only).");
    return;
  }
  const fs = require("fs");
  const path = require("path");
  const content = fs.readFileSync(path.join(__dirname, "ledger-log.jsonl"), "utf8");
  try {
    const existing = await githubStore.pullFile(GH);
    const sha = await githubStore.pushFile({
      ...GH,
      content,
      sha: existing ? existing.sha : undefined,
      message: `Add ledger entry: ${donor} (₹${amountCr}Cr)`,
    });
    console.log("Committed to GitHub, new sha:", sha);
  } catch (e) {
    console.error("GitHub sync failed (entry is still saved locally):", e.message);
  }
}

syncToGitHub();
