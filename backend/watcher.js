// watcher.js
//
// Runs on an hourly timer (wired up in server.js) or on-demand via
// POST /api/admin/watch/run. It checks the feeds in sources.json for
// articles that look like they might report a new donation or a new
// official CMRF total.
//
// Two paths from there:
//   - Trusted source (trusted-sources.json) + a complete, confident
//     extraction -> published immediately via publisher.js, and logged
//     to auto-published-log.jsonl for a visible audit trail.
//   - Anything else -> queued in pending-entries.json for a human to
//     review (see pendingStore.js and the /api/admin/pending endpoints).
//
// The trusted-source list should stay short and genuinely authoritative.
// This file never invents an amount or a donor name it isn't reasonably
// confident about — an incomplete extraction always falls through to the
// review queue, even from a trusted domain.

const https = require("https");
const fs = require("fs");
const path = require("path");
const { addCandidate } = require("./pendingStore");
const publisher = require("./publisher");

const SOURCES_PATH = path.join(__dirname, "sources.json");
const TRUSTED_PATH = path.join(__dirname, "trusted-sources.json");
const AUTO_LOG_PATH = path.join(__dirname, "auto-published-log.jsonl");

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
// accuracy — for non-trusted sources the human reviewer corrects it at
// approval time; for trusted sources, an incomplete guess simply means
// it does NOT auto-publish (see isComplete below).
function guessDonor(title) {
  const m = title.match(/^(.*?)\s+(donat\w*|contribut\w*|pledge\w*|gives?)\b/i);
  return m ? m[1].trim() : null;
}

function loadTrustedDomains() {
  if (!fs.existsSync(TRUSTED_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(TRUSTED_PATH, "utf8"));
    return (parsed.domains || []).map((d) => d.toLowerCase());
  } catch (e) {
    console.error("watcher: trusted-sources.json unreadable, treating as empty:", e.message);
    return [];
  }
}

function isTrustedLink(link, trustedDomains) {
  try {
    const hostname = new URL(link).hostname.toLowerCase().replace(/^www\./, "");
    return trustedDomains.some((d) => hostname === d || hostname.endsWith("." + d));
  } catch (e) {
    return false;
  }
}

// A candidate only auto-publishes if BOTH it's from a trusted domain AND
// every field it needs is present — an incomplete guess (e.g. no donor
// name found) always falls through to manual review, trusted source or not.
function isComplete(candidate) {
  return candidate.type === "donor_entry"
    ? Boolean(candidate.suggested.donor && candidate.suggested.amountCr && candidate.suggested.date)
    : Boolean(candidate.suggested.amountCr && candidate.suggested.date);
}

function readAutoPublishedLog() {
  if (!fs.existsSync(AUTO_LOG_PATH)) return [];
  return fs
    .readFileSync(AUTO_LOG_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function alreadyHandled(link, seenLinks) {
  return seenLinks.has(link);
}

function logAutoPublish(record) {
  fs.appendFileSync(AUTO_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n");
}

async function checkFeed(feed, trustedDomains, seenLinks) {
  const xml = await httpsGet(feed.url);
  const items = parseRssItems(xml);
  const queued = [];
  const autoPublished = [];

  for (const item of items) {
    if (!looksRelevant(item)) continue;
    if (alreadyHandled(item.link, seenLinks)) continue;

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

    const trusted = isTrustedLink(item.link, trustedDomains);
    const complete = isComplete(candidate);

    if (trusted && complete) {
      try {
        let result;
        if (type === "donor_entry") {
          result = await publisher.publishDonorEntry({
            donor: candidate.suggested.donor,
            amountCr: candidate.suggested.amountCr,
            date: candidate.suggested.date,
            src: candidate.sourceLink,
            srcName: candidate.sourceFeed,
          });
        } else {
          result = await publisher.publishTotalUpdate({
            amountCr: candidate.suggested.amountCr,
            date: candidate.suggested.date,
            src: candidate.sourceLink,
            srcName: candidate.sourceFeed,
          });
        }
        logAutoPublish({ type, headline: item.title, sourceLink: item.link, suggested: candidate.suggested, result });
        seenLinks.add(item.link);
        autoPublished.push(candidate);
        continue;
      } catch (e) {
        console.error(`watcher: auto-publish failed for "${item.title}", falling back to review queue:`, e.message);
        // fall through to the pending queue below instead of losing the candidate
      }
    }

    const added = addCandidate(candidate);
    if (added) queued.push(added);
    seenLinks.add(item.link);
  }

  return { queued, autoPublished };
}

async function runWatch() {
  if (!fs.existsSync(SOURCES_PATH)) {
    console.log("watcher: no sources.json found, skipping.");
    return { checked: 0, newCandidates: 0, autoPublished: 0 };
  }
  const { feeds } = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf8"));
  const trustedDomains = loadTrustedDomains();
  const seenLinks = new Set(readAutoPublishedLog().map((r) => r.sourceLink));

  let queued = [];
  let autoPublished = [];
  for (const feed of feeds || []) {
    try {
      const result = await checkFeed(feed, trustedDomains, seenLinks);
      queued = queued.concat(result.queued);
      autoPublished = autoPublished.concat(result.autoPublished);
    } catch (e) {
      console.error(`watcher: failed to check feed "${feed.name}":`, e.message);
    }
  }
  console.log(
    `watcher: checked ${feeds.length} feed(s) — ${autoPublished.length} auto-published (trusted source), ${queued.length} queued for review.`
  );
  return {
    checked: feeds.length,
    newCandidates: queued.length,
    autoPublished: autoPublished.length,
    candidates: queued,
    published: autoPublished,
  };
}

module.exports = { runWatch, readAutoPublishedLog };
