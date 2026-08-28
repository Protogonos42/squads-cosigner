// Offline tests over the devnet fixtures created by scripts/devnet-setup.js:
// one real proposal per verdict code on a 2-of-3 devnet multisig. Each fixture
// carries the raw create-instruction data; the static engine must return the
// expected verdict for every one of them. No RPC.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const sq = require("@sqds/multisig");
const lib = require("../dist/index.js");

const DIR = path.join(__dirname, "..", "fixtures", "devnet");
const RULES = lib.validateRules(JSON.parse(fs.readFileSync(path.join(DIR, "rules.json"), "utf8")));
const fixtures = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && !f.startsWith("fresh-") && !["rules.json", "multisig.json"].includes(f))
  .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")));

test("devnet fixtures cover every verdict code exactly once", () => {
  const codes = fixtures.map((f) => f.expectedVerdict).sort();
  assert.deepEqual(codes, ["APPROVE", "REFUSED_CONFIG_CHANGE", "REFUSED_COUNTERPARTY", "REFUSED_MINT_CUSTODY", "REFUSED_OVER_CAP", "REFUSED_THEFT_SHAPED", "REFUSED_UNSCREENABLE"]);
});

for (const fx of fixtures) {
  test(`devnet ${fx.scenario} → ${fx.expectedVerdict} (static, offline)`, () => {
    const data = Buffer.from(fx.ixDataBase64, "base64");
    let ev;
    if (fx.kind === "ConfigTransaction") {
      const [args] = sq.generated.configTransactionCreateStruct.deserialize(data);
      const actions = args.args.actions.map(({ __kind, ...rest }) => ({ kind: __kind, args: rest }));
      ev = lib.evaluateConfigTransaction({ kind: "ConfigTransaction", multisig: fx.multisig, creator: "", index: fx.transactionIndex, bump: 0, actions }, RULES);
    } else {
      const ix = lib.decodeVaultTransactionCreateIx(data);
      ev = lib.evaluateVaultMessage(ix.message, RULES);
    }
    assert.equal(ev.verdict, fx.expectedVerdict, JSON.stringify(ev.reasons));
    assert.equal(fx.vault, RULES.vault);
  });
}

test("the executed devnet proposal moved exactly what the rules allowed", () => {
  const fx = fixtures.find((f) => f.scenario === "approve-transfer");
  const ix = lib.decodeVaultTransactionCreateIx(Buffer.from(fx.ixDataBase64, "base64"));
  const ev = lib.evaluateVaultMessage(ix.message, RULES);
  assert.equal(ev.lamportsOut, "10000000");
  assert.ok(BigInt(ev.lamportsOut) <= BigInt(RULES.maxLamportsOut));
});
