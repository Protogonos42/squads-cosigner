// Offline tests for the simulation layer: lookup-table resolution in the decoder,
// and the pure static+simulated merge (`applySimulation`). No RPC. A live check
// against mainnet runs only when LIVE=1 (it needs network and takes ~5 s).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Keypair } = require("@solana/web3.js");
const lib = require("../dist/index.js");
const { encodeCompactMessage, u64, u32 } = require("./encode");

const RULES = lib.validateRules(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "rules.example.json"), "utf8")));
const VAULT = RULES.vault;
const MEMBER = "49i3Z51a5fxMksja4ui7VmPPtt4Wd2Duw6irnBiNrR26";
const SYSTEM = lib.SYSTEM_PROGRAM;
const TABLE = Keypair.generate().publicKey.toBase58();
const STRANGER = Keypair.generate().publicKey.toBase58();

// vault (writable signer) static; destination and System program come from a lookup table:
// lookup key 0 = writable (index 5 of the table), lookup key 1 = readonly (index 2 of the table)
const lutMessageBytes = encodeCompactMessage({
  numSigners: 1,
  numWritableSigners: 1,
  numWritableNonSigners: 0,
  accountKeys: [VAULT],
  instructions: [{ programIdIndex: 2, accountIndexes: [0, 1], data: Buffer.concat([u32(2), u64(1000)]) }],
  addressTableLookups: [{ table: TABLE, writableIndexes: [5], readonlyIndexes: [2] }],
});
const tableContents = () => {
  const addrs = Array.from({ length: 8 }, () => Keypair.generate().publicKey.toBase58());
  addrs[5] = MEMBER;
  addrs[2] = SYSTEM;
  return new Map([[TABLE, addrs]]);
};

test("unresolved lookup keys → REFUSED_UNSCREENABLE (strictLookupTables)", () => {
  const m = lib.decodeVaultMessage(lutMessageBytes);
  assert.equal(m.unresolvedLookupKeys, 2);
  assert.equal(m.instructions[0].programId, "<lookup#1>");
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_UNSCREENABLE");
  assert.equal(ev.reasons[0].rule, "strictLookupTables");
});

test("resolved lookup keys: program and destination become real pubkeys and the transfer APPROVEs", () => {
  const m = lib.decodeVaultMessage(lutMessageBytes, tableContents());
  assert.equal(m.unresolvedLookupKeys, 0);
  assert.equal(m.instructions[0].programId, SYSTEM);
  assert.deepEqual(m.instructions[0].accounts.map((a) => [a.pubkey, a.isWritable, a.fromLookupTable]), [[VAULT, true, false], [MEMBER, true, true]]);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "APPROVE", JSON.stringify(ev.reasons));
  assert.equal(ev.lamportsOut, "1000");
  // and web3 instructions can be rebuilt from it
  const ixs = lib.instructionsFromResolved(m);
  assert.equal(ixs.length, 1);
  assert.equal(ixs[0].programId.toBase58(), SYSTEM);
});

test("a table that lacks the referenced index leaves the key unresolved", () => {
  const short = new Map([[TABLE, [SYSTEM, SYSTEM, SYSTEM]]]); // index 5 missing
  const m = lib.decodeVaultMessage(lutMessageBytes, short);
  assert.equal(m.unresolvedLookupKeys, 1);
  assert.throws(() => lib.instructionsFromResolved(m), /unresolved lookup key/);
});

const okSim = (over = {}) => ({ ok: true, error: null, logs: [], vaultLamportsOut: "0", tokenOut: {}, ownershipChanges: [], ...over });
const staticApprove = { verdict: "APPROVE", reasons: [], lamportsOut: "5000000", tokenOut: {} };

test("applySimulation: failed simulation → REFUSED_UNSCREENABLE with the log tail", () => {
  const ev = lib.applySimulation(staticApprove, okSim({ ok: false, error: "simulation failed: X", logs: ["a", "b", "c", "Program failed: custom program error: 0x1"] }), RULES);
  assert.equal(ev.verdict, "REFUSED_UNSCREENABLE");
  assert.equal(ev.reasons[0].rule, "simulation");
  assert.match(ev.reasons[0].detail, /custom program error: 0x1/);
  assert.equal(ev.simulated, true);
});

test("applySimulation: simulated outflow above maxLamportsOut → REFUSED_OVER_CAP even when static passed", () => {
  const ev = lib.applySimulation(staticApprove, okSim({ vaultLamportsOut: "600000000" }), RULES);
  assert.equal(ev.verdict, "REFUSED_OVER_CAP");
  assert.equal(ev.reasons[0].rule, "maxLamportsOut(simulated)");
  assert.equal(ev.simulatedLamportsOut, "600000000");
});

test("applySimulation: token outflow above maxTokenOut['*'] → REFUSED_OVER_CAP", () => {
  const ev = lib.applySimulation(staticApprove, okSim({ tokenOut: { J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "2000000000" } }), RULES);
  assert.equal(ev.verdict, "REFUSED_OVER_CAP");
  assert.equal(ev.reasons[0].rule, "maxTokenOut(simulated)");
});

test("applySimulation: a vault-owned token account changing authority → REFUSED_THEFT_SHAPED (beats OVER_CAP)", () => {
  const ev = lib.applySimulation(staticApprove, okSim({ vaultLamportsOut: "600000000", ownershipChanges: [{ account: STRANGER, what: "token-authority", from: VAULT, to: STRANGER }] }), RULES);
  assert.equal(ev.verdict, "REFUSED_THEFT_SHAPED");
  assert.ok(ev.reasons.some((r) => r.rule === "simulated-ownership-change"));
});

test("applySimulation: maxUnexplainedLamportsOut catches outflow the static reading did not account for", () => {
  const rules = { ...RULES, maxUnexplainedLamportsOut: "10000" };
  const ev = lib.applySimulation(staticApprove, okSim({ vaultLamportsOut: "5020000" }), rules); // 20,000 unexplained
  assert.equal(ev.verdict, "REFUSED_OVER_CAP");
  assert.equal(ev.reasons[0].rule, "maxUnexplainedLamportsOut");
  const ok = lib.applySimulation(staticApprove, okSim({ vaultLamportsOut: "5005000" }), rules); // 5,000 unexplained: fine
  assert.equal(ok.verdict, "APPROVE");
});

test("applySimulation: a passing simulation within caps leaves APPROVE intact and carries the simulated totals", () => {
  const ev = lib.applySimulation(staticApprove, okSim({ vaultLamportsOut: "5000000" }), RULES);
  assert.equal(ev.verdict, "APPROVE");
  assert.equal(ev.simulatedLamportsOut, "5000000");
});

test("trustSimulationForAllowedPrograms: uninterpretable instruction to an allowed program is refused statically, tolerated when simulated", () => {
  const dex = Keypair.generate().publicKey.toBase58();
  const m = lib.decodeVaultMessage(encodeCompactMessage({ numSigners: 1, numWritableSigners: 1, numWritableNonSigners: 0, accountKeys: [VAULT, dex], instructions: [{ programIdIndex: 1, accountIndexes: [0], data: Buffer.from([1, 2, 3]) }] }));
  const rules = { ...RULES, allowPrograms: [...RULES.allowPrograms, dex], trustSimulationForAllowedPrograms: true };
  assert.equal(lib.evaluateVaultMessage(m, rules).verdict, "REFUSED_UNSCREENABLE");
  assert.equal(lib.evaluateVaultMessage(m, rules, { simulated: true }).verdict, "APPROVE");
  // never for an unlisted program
  assert.equal(lib.evaluateVaultMessage(m, { ...RULES, trustSimulationForAllowedPrograms: true }, { simulated: true }).verdict, "REFUSED_UNSCREENABLE");
});

test("live: simulate the author's fixture 1 against mainnet (LIVE=1 only)", { skip: !process.env.LIVE }, async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "mainnet", "5yYzcwpK", "vault-tx-1-create.json"), "utf8"));
  const ix = lib.decodeVaultTransactionCreateIx(Buffer.from(fx.ixDataBase64, "base64"));
  const out = await lib.checkWithSimulation(ix.innerMessageBytes, RULES, { feePayer: MEMBER });
  assert.equal(out.simulated, true);
  assert.ok(["APPROVE", "REFUSED_UNSCREENABLE"].includes(out.verdict)); // depends on the vault's current balance
});
