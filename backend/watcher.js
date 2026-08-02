// watcher.js
//
// Runs on an hourly timer (wired up in server.js) or on-demand via
// POST /api/admin/watch/run. It checks the feeds in sources.json for
// articles that look like they might report a new donation or a new
// official CMRF total, and drops them into pending-entries.json for a
// human to review and approve (see pendingStore.js).
//
// IMPORTANT: this file never writes to ledger-log.jsonl or
// official-data.json directly, and never pushes to GitHub. It only ever
// proposes. That boundary is intentional — see README.md's "why this
// isn't fully automatic" section.

const https = require("https");
const fs = require("fs");
const path = require("path");
const { addCandidate } = require("./pendingStore");

const SOURCES_PATH = path.join(__dirname, "sources.json");

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { "User-Agent": "assam-flood-relief-tracker-watcher/1.0" } },
        (res) => {
          // Follow a single redirect hop (Google News RSS links are direct, but
          // some outlets redirect once).
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            resolve(httpsGet(res.headers.location));
            return;
          }
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve(data));
        }
      )
      .on("error", reject);
  });
}

// Minimal RSS <item> extraction via regex — deliberately no XML-parser
// dependency, matching the rest of this backend's zero-extra-deps approach.
function parseRssItems(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    const description = (block.match(/<description>([\s\S]*?)<\/description>/) || [])[1];
    if (title && link) {
      items.push({
        title: decodeXml(stripCdata(title)),
        link: decodeXml(stripCdata(link)).trim(),
        pubDate: pubDate || null,
        snippet: description ? decodeXml(stripCdata(description)).replace(/<[^>]+>/g, "").slice(0, 400) : "",
      });
    }
  }
  return items;
}

function stripCdata(s) {
  return s.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Keyword gate: cheap first-pass filter before spending any extraction
// effort. Tune these lists in sources.json's feeds if you want tighter
// queries instead.
const DONATION_WORDS = /\b(donat|contribut|pledge|relief fund|cmrf)\b/i;
const AMOUNT_PATTERN = /₹?\s?(\d+(?:\.\d+)?)\s?(crore|cr\b|lakh|lac\b)/i;
const TOTAL_WORDS = /\b(total|cumulative|so far|collected)\b/i;

function looksRelevant(item) {
  const text = `${item.title} ${item.snippet}`;
  return DONATION_WORDS.test(text) && AMOUNT_PATTERN.test(text);
}

function extractAmountCr(text) {
  const m = text.match(AMOUNT_PATTERN);
  if (!m) return null;
  const num = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("lakh") || unit.startsWith("lac")) return +(num / 100).toFixed(4);
  return num;
}

// Best-effort donor name guess from the headline (e.g. "X donates ₹1 Cr
// to Assam flood relief" -> "X"). This is a heuristic, not a claim of
// accuracy — the human reviewer is expected to correct it at approval time.
function guessDonor(title) {
  const m = title.match(/^(.*?)\s+(donat\w*|contribut\w*|pledge\w*|gives?)\b/i);
  return m ? m[1].trim() : null;
}

async function checkFeed(feed) {
  const xml = await httpsGet(feed.url);
  const items = parseRssItems(xml);
  const found = [];
  for (const item of items) {
    if (!looksRelevant(item)) continue;
    const text = `${item.title} ${item.snippet}`;
    const amountCr = extractAmountCr(text);
    const type = TOTAL_WORDS.test(text) && /cmrf|relief fund/i.test(text) ? "total_update" : "donor_entry";
    const candidate = {
      type,
      status: "needs_review",
      sourceFeed: feed.name,
      sourceLink: item.link,
      headline: item.title,
      snippet: item.snippet,
      pubDate: item.pubDate,
      suggested: {
        donor: type === "donor_entry" ? guessDonor(item.title) : null,
        amountCr,
        date: item.pubDate ? new Date(item.pubDate).toISOString().slice(0, 10) : null,
      },
    };
    const added = addCandidate(candidate);
    if (added) found.push(added);
  }
  return found;
}

async function runWatch() {
  if (!fs.existsSync(SOURCES_PATH)) {
    console.log("watcher: no sources.json found, skipping.");
    return { checked: 0, newCandidates: 0 };
  }
  const { feeds } = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  let newCandidates = [];
  for (const feed of feeds || []) {
    try {
      const found = await checkFeed(feed);
      newCandidates = newCandidates.concat(found);
    } catch (e) {
      console.error(`watcher: failed to check feed "${feed.name}":`, e.message);
    }
  }
  console.log(`watcher: checked ${feeds.length} feed(s), found ${newCandidates.length} new candidate(s).`);
  return { checked: feeds.length, newCandidates: newCandidates.length, candidates: newCandidates };
}

module.exports = { runWatch };
