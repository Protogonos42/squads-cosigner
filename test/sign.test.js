// Offline tests for the signing layer: the gate policy and the exact outer
// transactions the tool would sign. No RPC, no keys from disk.
const test = require("node:test");
const assert = require("node:assert/strict");
const { Keypair, PublicKey } = require("@solana/web3.js");
const sq = require("@squads-protocol/multisig");
const lib = require("../dist/index.js");

const MS = new PublicKey("5yYzcwpKjZRn15GR5Evd93JpoAs6BrrNzMKUdeUstppa");
const member = Keypair.generate();
const fakeConn = { getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }) };

test("gate: approve only on APPROVE + Active", () => {
  assert.equal(lib.permits("approve", "APPROVE", "Active").ok, true);
  assert.equal(lib.permits("approve", "APPROVE", null).ok, true);
  assert.equal(lib.permits("approve", "APPROVE", "Approved").ok, false);
  for (const v of ["REFUSED_COUNTERPARTY", "REFUSED_OVER_CAP", "REFUSED_THEFT_SHAPED", "REFUSED_CONFIG_CHANGE", "REFUSED_MINT_CUSTODY", "REFUSED_UNSCREENABLE"]) {
    assert.equal(lib.permits("approve", v, "Active").ok, false, v);
    assert.equal(lib.permits("execute", v, "Approved").ok, false, v);
    assert.equal(lib.permits("reject", v, "Active").ok, true, v);
  }
});

test("gate: reject never fires on APPROVE; execute needs Approved/ExecuteReady", () => {
  assert.equal(lib.permits("reject", "APPROVE", "Active").ok, false);
  assert.equal(lib.permits("reject", "REFUSED_OVER_CAP", "Executed").ok, false);
  assert.equal(lib.permits("execute", "APPROVE", "Active").ok, false);
  assert.equal(lib.permits("execute", "APPROVE", "Approved").ok, true);
  assert.equal(lib.permits("execute", "APPROVE", "ExecuteReady").ok, true);
  assert.equal(lib.permits("execute", "APPROVE", null).ok, false);
});

test("buildApproveTx: one proposal_approve ix, member is the only signer, correct PDAs", async () => {
  const tx = await lib.buildApproveTx(fakeConn, MS, 7n, member.publicKey);
  const msg = tx.message;
  assert.equal(msg.header.numRequiredSignatures, 1);
  assert.equal(msg.staticAccountKeys[0].toBase58(), member.publicKey.toBase58());
  assert.equal(msg.compiledInstructions.length, 1);
  const ix = msg.compiledInstructions[0];
  assert.equal(msg.staticAccountKeys[ix.programIdIndex].toBase58(), sq.PROGRAM_ID.toBase58());
  const keys = ix.accountKeyIndexes.map((i) => msg.staticAccountKeys[i].toBase58());
  const { proposalPda } = lib.pdas(MS, 7n);
  assert.ok(keys.includes(MS.toBase58()));
  assert.ok(keys.includes(proposalPda.toBase58()));
  // discriminator = proposal_approve
  const expected = sq.instructions.proposalApprove({ multisigPda: MS, transactionIndex: 7n, member: member.publicKey }).data;
  assert.deepEqual(Buffer.from(ix.data), Buffer.from(expected));
  // unsigned until sign(): every signature is all-zero
  assert.ok(tx.signatures.every((s) => s.every((b) => b === 0)));
  tx.sign([member]);
  assert.ok(!tx.signatures[0].every((b) => b === 0));
});

test("buildRejectTx differs from approve only in discriminator", async () => {
  const a = await lib.buildApproveTx(fakeConn, MS, 7n, member.publicKey);
  const r = await lib.buildRejectTx(fakeConn, MS, 7n, member.publicKey);
  const da = Buffer.from(a.message.compiledInstructions[0].data);
  const dr = Buffer.from(r.message.compiledInstructions[0].data);
  assert.notDeepEqual(da.subarray(0, 8), dr.subarray(0, 8));
  assert.deepEqual(da.subarray(8), dr.subarray(8));
});

test("loadKeypair rejects anything but a 64-byte array", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const f = path.join(os.tmpdir(), `sc-${process.pid}.json`);
  fs.writeFileSync(f, JSON.stringify([1, 2, 3]));
  assert.throws(() => lib.loadKeypair(f), /64-byte/);
  fs.writeFileSync(f, JSON.stringify(Array.from(member.secretKey)));
  assert.equal(lib.loadKeypair(f).publicKey.toBase58(), member.publicKey.toBase58());
  fs.unlinkSync(f);
});
