// Offline tests against fixtures captured from mainnet (scripts/fetch-fixtures.js).
// Run: npm run build && npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { PublicKey } = require("@solana/web3.js");
const lib = require("../dist/index.js");

const FX = path.join(__dirname, "..", "fixtures", "mainnet", "5yYzcwpK");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FX, f), "utf8"));

const MULTISIG = "5yYzcwpKjZRn15GR5Evd93JpoAs6BrrNzMKUdeUstppa";
const VAULT = "5m53MMnwNTVUQQqbqEnuUJzb8iyti6Y3eX7nMq5ZmFuv";
const MEMBER = "49i3Z51a5fxMksja4ui7VmPPtt4Wd2Duw6irnBiNrR26";
const COSIGNER = "8uGJ8bdWSKUtaW6kpBJriuir6eE4kxtW2V7dt8rBi84f";

test("multisig account decodes: 2-of-3, config authority none, rent collector = proposer", () => {
  const fx = load("multisig.json");
  const data = Buffer.from(fx.dataBase64, "base64");
  assert.equal(lib.accountKind(data), "Multisig");
  const ms = lib.decodeMultisig(data, new PublicKey(MULTISIG));
  assert.equal(ms.threshold, 2);
  assert.equal(ms.members.length, 3);
  assert.equal(ms.configAuthority, null);
  assert.equal(ms.rentCollector, MEMBER);
  assert.equal(ms.vault0, VAULT);
  const me = ms.members.find((m) => m.key === MEMBER);
  assert.deepEqual(me.permissions, { mask: 3, initiate: true, vote: true, execute: false });
  const co = ms.members.find((m) => m.key === COSIGNER);
  assert.deepEqual(co.permissions, { mask: 6, initiate: false, vote: true, execute: true });
  assert.ok(BigInt(ms.transactionIndex) >= 2n);
});

test("PDAs derive to the addresses recorded on-chain", () => {
  const fx = load("vault-tx-1-create.json");
  const p = lib.pdas(new PublicKey(MULTISIG), 1n);
  assert.equal(p.transactionPda.toBase58(), fx.transactionPda);
  assert.equal(p.proposalPda.toBase58(), fx.proposalPda);
  assert.equal(p.vaultPda.toBase58(), VAULT);
});

test("index 1: plain 0.005 SOL vault→member transfer", () => {
  const fx = load("vault-tx-1-create.json");
  const ix = lib.decodeVaultTransactionCreateIx(Buffer.from(fx.ixDataBase64, "base64"));
  assert.equal(ix.vaultIndex, 0);
  assert.equal(ix.ephemeralSigners, 0);
  assert.equal(ix.message.instructions.length, 1);
  const i0 = ix.message.instructions[0];
  assert.equal(i0.programName, "system");
  assert.equal(i0.explain.op, "system.transfer");
  assert.equal(i0.explain.detail.from, VAULT);
  assert.equal(i0.explain.detail.to, MEMBER);
  assert.equal(i0.explain.detail.lamports, "5000000");
  assert.equal(i0.explain.flags.movesLamports, true);
  assert.equal(ix.message.unresolvedLookupKeys, 0);
  // the vault is the (only) signer of the inner message
  const signer = i0.accounts.find((a) => a.pubkey === VAULT);
  assert.equal(signer.isSigner, true);
  assert.equal(signer.isWritable, true);
});

test("index 2: ATA create + Jito stake-pool DepositSol of 0.4 SOL", () => {
  const fx = load("vault-tx-2-create.json");
  const ix = lib.decodeVaultTransactionCreateIx(Buffer.from(fx.ixDataBase64, "base64"));
  const ops = ix.message.instructions.map((i) => i.explain.op);
  assert.deepEqual(ops, ["spl-associated-token-account.createIdempotent", "spl-stake-pool.depositSol"]);
  const dep = ix.message.instructions[1].explain;
  assert.equal(dep.detail.lamports, "400000000");
  assert.equal(dep.detail.from, VAULT);
  assert.equal(dep.detail.poolMint, "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
  assert.equal(ix.message.instructions[0].explain.detail.owner, VAULT);
  // no instruction in either fixture creates a mint, mints, changes authority, or touches Squads config
  for (const i of ix.message.instructions) {
    assert.ok(!i.explain.flags.createsMint && !i.explain.flags.mintsTokens && !i.explain.flags.changesAuthority && !i.explain.flags.squadsConfig);
  }
});

test("inner message bytes round-trip through decodeVaultMessage identically", () => {
  const fx = load("vault-tx-2-create.json");
  const ix = lib.decodeVaultTransactionCreateIx(Buffer.from(fx.ixDataBase64, "base64"));
  assert.equal(Buffer.from(ix.innerMessageBytes).toString("base64"), fx.innerMessageBase64);
  const again = lib.decodeVaultMessage(ix.innerMessageBytes);
  assert.deepEqual(again, ix.message);
});

test("non-Squads / garbage bytes are Unknown, not a crash", () => {
  assert.equal(lib.accountKind(Buffer.alloc(0)), "Unknown");
  assert.equal(lib.accountKind(Buffer.alloc(64)), "Unknown");
  assert.throws(() => lib.decodeVaultTransactionCreateIx(Buffer.alloc(16)), /not a vault_transaction_create/);
});
