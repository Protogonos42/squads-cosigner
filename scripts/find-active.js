#!/usr/bin/env node
// List live Active proposals across all Squads v4 multisigs on mainnet, with a
// one-line decode of each vault transaction. Free (read-only); ~4 s on the
// public RPC. Useful as live test material for `check`.
//
// Proposal layout: 8 discriminator | 32 multisig | 8 transactionIndex | status
// (1-byte kind: Draft=0 Active=1 Rejected=2 Approved=3 Executing=4 Executed=5
// Cancelled=6, then optional i64 timestamp) ...  → status kind is at offset 48.
//
// usage: node scripts/find-active.js [--limit N] [--rpc URL]
const { Connection, PublicKey } = require("@solana/web3.js");
const sq = require("@squads-protocol/multisig");
const bs58 = require("bs58");
const lib = require("../dist");

const args = process.argv.slice(2);
const flag = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const limit = Number(flag("--limit", 10));
const rpc = flag("--rpc", process.env.RPC_URL || "https://api.mainnet-beta.solana.com");

(async () => {
  const c = new Connection(rpc, "confirmed");
  const t0 = Date.now();
  const r = await c.getProgramAccounts(sq.PROGRAM_ID, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(sq.generated.proposalDiscriminator)) } },
      { memcmp: { offset: 48, bytes: bs58.encode(Buffer.from([1])) } },
    ],
  });
  console.error(`${r.length} Active proposals in ${Date.now() - t0} ms`);
  let shown = 0;
  for (const { pubkey, account } of r) {
    const p = lib.decodeProposal(account.data);
    const { transactionPda } = lib.pdas(new PublicKey(p.multisig), BigInt(p.transactionIndex));
    const t = await c.getAccountInfo(transactionPda);
    if (!t) continue;
    const d = lib.decodeAccount(t.data);
    const line = { proposal: pubkey.toBase58(), multisig: p.multisig, index: p.transactionIndex, approved: p.approved.length, kind: d.kind };
    if (d.kind === "VaultTransaction") {
      line.lookupKeys = d.message.unresolvedLookupKeys;
      line.ops = d.message.instructions.map((i) => i.explain.op);
      line.programs = [...new Set(d.message.instructions.map((i) => i.programName ?? i.programId))];
    }
    console.log(JSON.stringify(line));
    if (++shown >= limit) break;
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
