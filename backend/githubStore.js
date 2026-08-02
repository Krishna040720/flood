// githubStore.js
//
// Minimal GitHub Contents API client, built on Node's built-in https module
// only — no octokit, no extra npm dependency to install (matters when
// you're on a $0 budget and want the least amount that can go wrong).
//
// Used to store the ledger log as a file in a GitHub repo instead of on
// Render's ephemeral disk. Every append becomes a real git commit, so the
// commit history itself becomes a second, independent way for anyone to
// verify the ledger wasn't quietly rewritten — not just the hash chain.

const https = require("https");

// `hostname` is overridable so this can be pointed at a local mock server
// in tests without touching real GitHub.
function ghRequest(method, path, token, body, hostname = "api.github.com") {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers: {
          "User-Agent": "assam-flood-relief-tracker",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          ...(data
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
            : {}),
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => (chunks += c));
        res.on("end", () => {
          let parsed = null;
          try {
            parsed = chunks ? JSON.parse(chunks) : null;
          } catch (e) {
            /* leave parsed null on non-JSON body */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Returns { content, sha } for the file, or null if it doesn't exist yet
// (a fresh repo with no ledger file committed).
async function pullFile({ owner, repo, path, branch, token }, hostname) {
  const qs = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  const res = await ghRequest(
    "GET",
    `/repos/${owner}/${repo}/contents/${path}${qs}`,
    token,
    null,
    hostname
  );
  if (res.status === 404) return null;
  if (res.status !== 200) {
    throw new Error(`GitHub pull failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return {
    content: Buffer.from(res.body.content, "base64").toString("utf8"),
    sha: res.body.sha,
  };
}

// Commits `content` to the file. Pass `sha` from a prior pullFile() to
// update an existing file; omit it to create the file for the first time.
async function pushFile({ owner, repo, path, branch, token, content, sha, message }, hostname) {
  const body = {
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    ...(sha ? { sha } : {}),
    ...(branch ? { branch } : {}),
  };
  const res = await ghRequest(
    "PUT",
    `/repos/${owner}/${repo}/contents/${path}`,
    token,
    body,
    hostname
  );
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`GitHub push failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.content.sha;
}

module.exports = { pullFile, pushFile, ghRequest };
