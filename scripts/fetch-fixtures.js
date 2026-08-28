#!/usr/bin/env node
// Rebuild offline fixtures from mainnet for a Squads v4 multisig whose
// proposal/transaction accounts may already be CLOSED (rent reclaimed).
// For each transaction index we find the `vault_transaction_create`
// instruction that created it and store its raw ix data (which carries the
// full inner VaultTransactionMessage), plus the live Multisig account bytes.
//
// usage: node scripts/fetch-fixtures.js <multisig> <index> [<index>...]
const fs = require("fs");
const path = require("path");
const { Connection, PublicKey } = require("@solana/web3.js");
const sq = require("@sqds/multisig");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM = sq.PROGRAM_ID;
const DISC = Buffer.from(sq.generated.vaultTransactionCreateInstructionDiscriminator);

(async () => {
  const [msArg, ...idxArgs] = process.argv.slice(2);
  if (!msArg || idxArgs.length === 0) {
    console.error("usage: fetch-fixtures.js <multisig> <index>...");
    process.exit(2);
  }
  const conn = new Connection(RPC, "confirmed");
  const multisigPda = new PublicKey(msArg);
  const outDir = path.join(__dirname, "..", "fixtures", "mainnet", multisigPda.toBase58().slice(0, 8));
  fs.mkdirSync(outDir, { recursive: true });

  // 1. live multisig account
  const msInfo = await conn.getAccountInfo(multisigPda);
  if (!msInfo) throw new Error("multisig account not found");
  fs.writeFileSync(
    path.join(outDir, "multisig.json"),
    JSON.stringify({ address: multisigPda.toBase58(), owner: msInfo.owner.toBase58(), lamports: msInfo.lamports, dataBase64: msInfo.data.toString("base64"), fetchedAt: new Date().toISOString(), rpc: RPC }, null, 2)
  );
  console.log("multisig:", multisigPda.toBase58(), msInfo.data.length, "bytes");

  // 2. per-index create instruction
  for (const idxStr of idxArgs) {
    const transactionIndex = BigInt(idxStr);
    const [transactionPda] = sq.getTransactionPda({ multisigPda, index: transactionIndex });
    const [proposalPda] = sq.getProposalPda({ multisigPda, transactionIndex });
    const sigs = await conn.getSignaturesForAddress(transactionPda, { limit: 50 });
    let found = null;
    for (const s of sigs.reverse()) {
      // oldest first
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (!tx) continue;
      const msg = tx.transaction.message;
      const keys = msg.staticAccountKeys ?? msg.accountKeys;
      const ixs = msg.compiledInstructions ?? msg.instructions;
      for (const ix of ixs) {
        const pid = keys[ix.programIdIndex];
        if (!pid.equals(PROGRAM)) continue;
        const data = Buffer.from(ix.data);
        if (!data.subarray(0, 8).equals(DISC)) continue;
        const accountKeyIndexes = ix.accountKeyIndexes ?? ix.accounts;
        found = {
          multisig: multisigPda.toBase58(),
          transactionIndex: transactionIndex.toString(),
          transactionPda: transactionPda.toBase58(),
          proposalPda: proposalPda.toBase58(),
          createSignature: s.signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          programId: pid.toBase58(),
          accounts: accountKeyIndexes.map((i) => keys[i].toBase58()),
          ixDataBase64: data.toString("base64"),
          allSignatures: sigs.map((x) => ({ signature: x.signature, slot: x.slot, err: x.err, blockTime: x.blockTime })),
          fetchedAt: new Date().toISOString(),
          rpc: RPC,
        };
      }
      if (found) break;
    }
    if (!found) {
      console.error("index", idxStr, ": no vault_transaction_create found among", sigs.length, "signatures");
      continue;
    }
    // sanity: the SDK must be able to deserialize it
    const [args] = sq.generated.vaultTransactionCreateStruct.deserialize(Buffer.from(found.ixDataBase64, "base64"));
    found.vaultIndex = args.args.vaultIndex;
    found.ephemeralSigners = args.args.ephemeralSigners;
    found.memo = args.args.memo;
    found.innerMessageBase64 = Buffer.from(args.args.transactionMessage).toString("base64");
    const f = path.join(outDir, `vault-tx-${idxStr}-create.json`);
    fs.writeFileSync(f, JSON.stringify(found, null, 2));
    console.log("index", idxStr, "→", f, "sig", found.createSignature, "inner", args.args.transactionMessage.length, "bytes");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
