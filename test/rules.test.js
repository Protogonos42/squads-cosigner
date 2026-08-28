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

test("config.timelock: SetTimeLock refused when shortening or when current is unknown; allowed when lengthening", () => {
  const rules = { ...RULES, allowConfigTransactions: true };
  const tx = (newTimeLock) => ({ kind: "ConfigTransaction", multisig: "x", creator: "y", index: "4", bump: 0, actions: [{ kind: "SetTimeLock", args: { newTimeLock } }] });
  let ev = lib.evaluateConfigTransaction(tx(0), rules, { currentTimeLock: 3600 });
  assert.equal(ev.verdict, "REFUSED_THEFT_SHAPED");
  assert.equal(ev.reasons[0].rule, "config.timelock");
  ev = lib.evaluateConfigTransaction(tx(7200), rules);
  assert.equal(ev.verdict, "REFUSED_THEFT_SHAPED", "unknown current time lock must refuse");
  ev = lib.evaluateConfigTransaction(tx(7200), rules, { currentTimeLock: 3600 });
  assert.equal(ev.verdict, "APPROVE");
  ev = lib.evaluateConfigTransaction(tx(3600), rules, { currentTimeLock: 3600 });
  assert.equal(ev.verdict, "APPROVE", "equal is not a shortening");
  // default rules still refuse it as a config change regardless of context
  assert.equal(lib.evaluateConfigTransaction(tx(7200), RULES, { currentTimeLock: 0 }).verdict, "REFUSED_CONFIG_CHANGE");
});

test("config.spendingLimit: AddSpendingLimit refused, RemoveSpendingLimit allowed (when config txs are opted in)", () => {
  const rules = { ...RULES, allowConfigTransactions: true };
  const add = { kind: "ConfigTransaction", multisig: "x", creator: "y", index: "5", bump: 0, actions: [{ kind: "AddSpendingLimit", args: { members: [STRANGER], amount: "1000000000", vaultIndex: 0 } }] };
  const ev = lib.evaluateConfigTransaction(add, rules, { currentTimeLock: 0 });
  assert.equal(ev.verdict, "REFUSED_THEFT_SHAPED");
  assert.equal(ev.reasons[0].rule, "config.spendingLimit");
  const rm = { ...add, actions: [{ kind: "RemoveSpendingLimit", args: { spendingLimit: STRANGER } }] };
  assert.equal(lib.evaluateConfigTransaction(rm, rules, { currentTimeLock: 0 }).verdict, "APPROVE");
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

// --- durable-nonce instructions (System tags 4–7, 12) ---
// Before these were decoded they fell into the `interpretable` fallback: refused by default, but
// unread under trustSimulationForAllowedPrograms. A nonce authority handoff is a theft shape.
test("REFUSED_THEFT_SHAPED: system.authorizeNonceAccount hands a vault-signed nonce to a stranger", () => {
  const nonce = Keypair.generate().publicKey.toBase58();
  const data = Buffer.concat([u32(7), Keypair.generate().publicKey.toBuffer()]);
  const m = msg([VAULT, nonce, SYSTEM], [{ programIdIndex: 2, accountIndexes: [1, 0], data }], 1);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_THEFT_SHAPED");
  assert.equal(ev.reasons[0].rule, "no-authority-handoff");
  assert.match(ev.reasons[0].detail, /authorizeNonceAccount/);
});

test("APPROVE: system.advanceNonceAccount is benign; initializeNonceAccount with the vault as authority hands nothing over", () => {
  const nonce = Keypair.generate().publicKey.toBase58();
  const advance = { programIdIndex: 2, accountIndexes: [1, 3, 0], data: u32(4) };
  const init = { programIdIndex: 2, accountIndexes: [1, 3, 4], data: Buffer.concat([u32(6), Buffer.from(require("bs58").decode(VAULT))]) };
  const SYSVAR_RB = "SysvarRecentB1ockHashes11111111111111111111";
  const SYSVAR_RENT = "SysvarRent111111111111111111111111111111111";
  const m = msg([VAULT, nonce, SYSTEM, SYSVAR_RB, SYSVAR_RENT], [advance, init], 1);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "APPROVE", JSON.stringify(ev.reasons));
});

test("REFUSED_COUNTERPARTY: system.withdrawNonceAccount to an unlisted destination", () => {
  const nonce = Keypair.generate().publicKey.toBase58();
  const SYSVAR_RB = "SysvarRecentB1ockHashes11111111111111111111";
  const SYSVAR_RENT = "SysvarRent111111111111111111111111111111111";
  const ix = { programIdIndex: 3, accountIndexes: [1, 2, 4, 5, 0], data: Buffer.concat([u32(5), u64(1000)]) };
  const m = msg([VAULT, nonce, STRANGER, SYSTEM, SYSVAR_RB, SYSVAR_RENT], [ix], 2);
  const ev = lib.evaluateVaultMessage(m, RULES);
  assert.equal(ev.verdict, "REFUSED_COUNTERPARTY", JSON.stringify(ev.reasons));
});

// --- Token-2022 extension instructions (tags 26, 27, 37, 38, 42) ---
// Before these were decoded they fell into the `interpretable` fallback: refused by default, but
// unread under trustSimulationForAllowedPrograms. Confidential balances are encrypted, so a
// confidential transfer moves value without the visible `amount` field changing — invisible to a diff.
const TOKEN22 = lib.TOKEN_2022_PROGRAM;
const TRUST = { ...RULES, trustSimulationForAllowedPrograms: true, allowPrograms: [...(RULES.allowPrograms ?? []), TOKEN22] };

test("REFUSED_UNSCREENABLE: spl-token-2022 confidentialTransfer.transfer by the vault, even when simulation is trusted", () => {
  const src = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const data = Buffer.concat([Buffer.from([27, 7]), Buffer.alloc(64)]);
  const m = msg([VAULT, src, STRANGER, mint, TOKEN22], [{ programIdIndex: 4, accountIndexes: [1, 3, 2, 0], data }], 2);
  const ev = lib.evaluateVaultMessage(m, TRUST, { simulated: true });
  assert.equal(ev.verdict, "REFUSED_UNSCREENABLE", JSON.stringify(ev.reasons));
  assert.equal(ev.reasons[0].rule, "no-confidential-balances");
  assert.match(ev.reasons[0].detail, /confidentialTransfer\.transfer/);
});

test("transferFee.transferCheckedWithFee: counted as a token transfer — APPROVE to a listed destination, REFUSED_COUNTERPARTY otherwise", () => {
  const src = Keypair.generate().publicKey.toBase58();
  const mint = Keypair.generate().publicKey.toBase58();
  const data = Buffer.concat([Buffer.from([26, 1]), u64(5000), Buffer.from([6]), u64(50)]);
  const ok = msg([VAULT, src, MEMBER, mint, TOKEN22], [{ programIdIndex: 4, accountIndexes: [1, 3, 2, 0], data }], 2);
  const evOk = lib.evaluateVaultMessage(ok, TRUST);
  assert.equal(evOk.verdict, "APPROVE", JSON.stringify(evOk.reasons));
  assert.equal(evOk.tokenOut[mint], "5000");
  const bad = msg([VAULT, src, STRANGER, mint, TOKEN22], [{ programIdIndex: 4, accountIndexes: [1, 3, 2, 0], data }], 2);
  const evBad = lib.evaluateVaultMessage(bad, TRUST);
  assert.equal(evBad.verdict, "REFUSED_COUNTERPARTY", JSON.stringify(evBad.reasons));
  assert.equal(evBad.reasons[0].rule, "destinations");
});

test("REFUSED_COUNTERPARTY: spl-token-2022 withdrawExcessLamports authorised by the vault to an unlisted destination", () => {
  const src = Keypair.generate().publicKey.toBase58();
  const m = msg([VAULT, src, STRANGER, TOKEN22], [{ programIdIndex: 3, accountIndexes: [1, 2, 0], data: Buffer.from([38]) }], 2);
  const ev = lib.evaluateVaultMessage(m, TRUST, { simulated: true });
  assert.equal(ev.verdict, "REFUSED_COUNTERPARTY", JSON.stringify(ev.reasons));
  assert.match(ev.reasons[0].detail, /withdrawExcessLamports/);
});

test("default rules: undecoded Token-2022 extension tags still refuse as REFUSED_UNSCREENABLE (interpretable)", () => {
  const acct = Keypair.generate().publicKey.toBase58();
  const m = msg([VAULT, acct, TOKEN22], [{ programIdIndex: 2, accountIndexes: [1, 0], data: Buffer.from([34, 0]) }], 1);
  const ev = lib.evaluateVaultMessage(m, { ...RULES, allowPrograms: [...(RULES.allowPrograms ?? []), TOKEN22] });
  assert.equal(ev.verdict, "REFUSED_UNSCREENABLE", JSON.stringify(ev.reasons));
  assert.equal(ev.reasons[0].rule, "interpretable");
});
