// add-ledger-entry.js
//
// Run this whenever a new donation gets reported, instead of hand-editing
// ledger-log.jsonl. It appends correctly to the hash chain so the log
// stays verifiable.
//
// Usage:
//   node add-ledger-entry.js "Donor Name" 1.5 "01 Aug 2026" reported "https://source-url" "Source Name"

const { appendEntry } = require("./ledgerChain");

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

console.log("Appended and chained:");
console.log(record);
