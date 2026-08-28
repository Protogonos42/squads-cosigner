// Rule-engine tests: the two real mainnet proposals must APPROVE under the
// example rules; one synthetic message per refusal code must be refused with
// that code, citing the instruction that fired.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Keypair } = require("@solana/web3.js");
const lib = require("../dist/index.js");
const { encodeCompactMessage, u64, u32 } = require("./encode");

const FX = path.join(__dirname, "..", "fixtures", "mainnet", "5yYzcwpK");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));
const RULES = lib.validateRules(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "rules.example.json"), "utf8")));

const VAULT = RULES.vault;
const MEMBER = "49i3Z51a5fxMksja4ui7VmPPtt4Wd2Duw6irnBiNrR26";
const STRANGER = Keypair.generate().publicKey.toBase58();
const SYSTEM = lib.SYSTEM_PROGRAM;
const TOKEN = lib.TOKEN_PROGRAM;

const decodeFixture = (f) => lib.decodeVaultTransactionCreateIx(Buffer.from(load(f).ixDataBase64, "base64")).message;

// vault is the single writable signer; keys after it are writable non-signers up to numWritableNonSigners, then readonly
function msg(keys, instructions, numWritableNonSigners) {
  return lib.decodeVaultMessage(
    encodeCompactMessage({ numSigners: 1, numWritableSigners: 1, numWritableNonSigners, accountKeys: keys, instructions })
  );
}
const sysTransfer = (fromIdx, toIdx, lamports, programIdx) => ({ programIdIndex: programIdx, accountIndexes: [fromIdx, toIdx], data: Buffer.concat([u32(2), u64(lamports)]) });

test("real proposal 1 (0.005 SOL to member) → APPROVE", () => {
  const ev = lib.evaluateVaultMessage(decodeFixture("vault-tx-1-create.json"), RULES);
  assert.equal(ev.verdict, "APPROVE", JSON.stringify(ev.reasons));
  assert.equal(ev.lamportsOut, "5000000");
});

test("real proposal 2 (ATA create + Jito DepositSol 0.4 SOL) → APPROVE", () => {
  const ev = lib.evaluateVaultMessage(decodeFixture("vault-tx-2-create.json"), RULES);
  assert.equal(ev.verdict, "APPROVE", JSON.stringify(ev.reasons));
  assert.equal(ev.lamportsOut, "400000000"); // ATA create carries no static lamport amount
});

test("REFUSED_COUNTERPARTY: transfer to an address not in allowDestinations", () => {
  const m = msg([VAULT, STRANGER, SYSTEM], [sysTransfer(0, 1, 1000, 2)], 1);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_COUNTERPARTY");
  assert.equal(ev.reasons[0].instruction, 0);
  assert.match(ev.reasons[0].detail, /not in allowDestinations/);
});

test("REFUSED_OVER_CAP: two transfers to an allowed destination summing above maxLamportsOut", () => {
  const m = msg([VAULT, MEMBER, SYSTEM], [sysTransfer(0, 1, 300_000_000, 2), sysTransfer(0, 1, 300_000_000, 2)], 1);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_OVER_CAP");
  assert.equal(ev.lamportsOut, "600000000");
});

test("REFUSED_THEFT_SHAPED: system.assign on the vault", () => {
  const ownerBytes = Keypair.generate().publicKey.toBuffer();
  const m = msg([VAULT, SYSTEM], [{ programIdIndex: 1, accountIndexes: [0], data: Buffer.concat([u32(1), ownerBytes]) }], 0);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_THEFT_SHAPED");
});

test("REFUSED_THEFT_SHAPED: spl-token setAuthority on a vault-signed account", () => {
  const ata = Keypair.generate().publicKey.toBase58();
  // setAuthority: accounts [account, currentAuthority]; data [6, authorityType, option=1, newAuthority]
  const data = Buffer.concat([Buffer.from([6, 2, 1]), Keypair.generate().publicKey.toBuffer()]);
  const m = msg([VAULT, ata, TOKEN], [{ programIdIndex: 2, accountIndexes: [1, 0], data }], 1);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_THEFT_SHAPED");
  assert.equal(ev.reasons[0].rule, "no-authority-handoff");
});

test("REFUSED_THEFT_SHAPED: closeAccount sending rent to a stranger", () => {
  const ata = Keypair.generate().publicKey.toBase58();
  const m = msg([VAULT, ata, STRANGER, TOKEN], [{ programIdIndex: 3, accountIndexes: [1, 2, 0], data: Buffer.from([9]) }], 2);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_THEFT_SHAPED");
  assert.equal(ev.reasons[0].rule, "close-to-foreign");
});

test("REFUSED_MINT_CUSTODY: initializeMint", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const m = msg([VAULT, mint, TOKEN], [{ programIdIndex: 2, accountIndexes: [1], data: Buffer.alloc(67) }], 1);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_MINT_CUSTODY");
  assert.equal(ev.reasons[0].rule, "no-mint-creation");
});

test("REFUSED_MINT_CUSTODY: mintTo", () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const dest = Keypair.generate().publicKey.toBase58();
  const m = msg([VAULT, mint, dest, TOKEN], [{ programIdIndex: 3, accountIndexes: [1, 2, 0], data: Buffer.concat([Buffer.from([7]), u64(1)]) }], 2);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_MINT_CUSTODY");
});

test("REFUSED_MINT_CUSTODY: token transfer authorised by someone other than the vault", () => {
  const src = Keypair.generate().publicKey.toBase58();
  const m = msg([VAULT, src, MEMBER, STRANGER, TOKEN], [{ programIdIndex: 4, accountIndexes: [1, 2, 3], data: Buffer.concat([Buffer.from([3]), u64(5)]) }], 2);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_MINT_CUSTODY");
  assert.equal(ev.reasons[0].rule, "own-tokens-only");
});

test("REFUSED_CONFIG_CHANGE: vault message that CPIs into Squads", () => {
  const m = msg([VAULT, lib.SQUADS_V4], [{ programIdIndex: 1, accountIndexes: [0], data: Buffer.alloc(8) }], 0);
  const rules = { ...RULES, allowPrograms: [...RULES.allowPrograms, lib.SQUADS_V4] };
  const ev = lib.evaluateVaultMessage(m, rules);
  assert.equal(ev.verdict, "REFUSED_CONFIG_CHANGE");
});

test("REFUSED_CONFIG_CHANGE: any ConfigTransaction under default rules", () => {
  const tx = { kind: "ConfigTransaction", multisig: "x", creator: "y", index: "3", bump: 0, actions: [{ kind: "ChangeThreshold", args: { newThreshold: 1 } }] };
  assert.equal(lib.evaluateConfigTransaction(tx, RULES).verdict, "REFUSED_CONFIG_CHANGE");
  // even when config txs are allowed, membership changes stay theft-shaped
  assert.equal(lib.evaluateConfigTransaction(tx, { ...RULES, allowConfigTransactions: true }).verdict, "REFUSED_THEFT_SHAPED");
});

test("REFUSED_UNSCREENABLE: program not in allowPrograms", () => {
  const prog = Keypair.generate().publicKey.toBase58();
  const m = msg([VAULT, prog], [{ programIdIndex: 1, accountIndexes: [0], data: Buffer.from([1, 2, 3]) }], 0);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_UNSCREENABLE");
  assert.equal(ev.reasons[0].rule, "allowPrograms");
});

test("REFUSED_UNSCREENABLE: unresolved address-lookup-table accounts under strict rules", () => {
  const raw = encodeCompactMessage({
    numSigners: 1, numWritableSigners: 1, numWritableNonSigners: 0,
    accountKeys: [VAULT, SYSTEM],
    instructions: [{ programIdIndex: 1, accountIndexes: [0, 2], data: Buffer.concat([u32(2), u64(1)]) }],
    addressTableLookups: [{ table: Keypair.generate().publicKey.toBase58(), writableIndexes: [7], readonlyIndexes: [] }],
  });
  const m = lib.decodeVaultMessage(raw);
  assert.equal(m.unresolvedLookupKeys, 1);
  assert.equal(lib.evaluateVaultMessage(m, RULES).verdict, "REFUSED_UNSCREENABLE");
});

test("REFUSED_COUNTERPARTY beats REFUSED_OVER_CAP; CONFIG beats everything", () => {
  const m = msg([VAULT, STRANGER, SYSTEM, lib.SQUADS_V4], [sysTransfer(0, 1, 10_000_000_000, 2), { programIdIndex: 3, accountIndexes: [0], data: Buffer.alloc(8) }], 1);
  const rules = { ...RULES, allowPrograms: [...RULES.allowPrograms, lib.SQUADS_V4] };
  const ev = lib.evaluateVaultMessage(m, rules);
  assert.equal(ev.verdict, "REFUSED_CONFIG_CHANGE");
  const codes = new Set(ev.reasons.map((r) => r.verdict));
  assert.ok(codes.has("REFUSED_COUNTERPARTY") && codes.has("REFUSED_OVER_CAP"));
});

test("validateRules rejects a rules file without a vault", () => {
  assert.throws(() => lib.validateRules({ allowPrograms: [] }), /vault/);
});
