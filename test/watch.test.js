// Offline tests for the audit log: a chain written by `watch` verifies, and
// any edit to any entry breaks verification at that entry.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("../dist/index.js");

const REAL = path.join(__dirname, "..", "fixtures", "devnet", "audit.jsonl");

test("the devnet daemon's audit log verifies and never signed a refused proposal", () => {
  const r = lib.verifyAuditLog(REAL);
  assert.equal(r.ok, true, JSON.stringify(r));
  const entries = fs.readFileSync(REAL, "utf8").trim().split("\n").map(JSON.parse);
  for (const e of entries) {
    if (e.verdict !== "APPROVE") assert.equal(e.signed, false, `signed a ${e.verdict} proposal: seq ${e.seq}`);
    if (e.signed) assert.equal(e.verdict, "APPROVE");
  }
  assert.ok(entries.some((e) => e.action === "approve" && e.signed));
  assert.ok(entries.some((e) => e.action === "execute" && e.signed));
});

test("tampering with any field breaks the chain at that entry", () => {
  const entries = fs.readFileSync(REAL, "utf8").trim().split("\n");
  const f = path.join(os.tmpdir(), `audit-${process.pid}.jsonl`);
  for (let i = 0; i < entries.length; i++) {
    const copy = entries.map(JSON.parse);
    copy[i].verdict = copy[i].verdict === "APPROVE" ? "REFUSED_OVER_CAP" : "APPROVE";
    fs.writeFileSync(f, copy.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const r = lib.verifyAuditLog(f);
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, i);
  }
  // deleting a middle entry also breaks it
  fs.writeFileSync(f, entries.filter((_, i) => i !== 2).join("\n") + "\n");
  assert.equal(lib.verifyAuditLog(f).ok, false);
  fs.unlinkSync(f);
});
