#!/usr/bin/env node
// One-off: plain SystemProgram transfer from $PROPOSER (own float) to the
// dogfood vault 0 recorded in fixtures/mainnet-dogfood/multisig.json.
// Simulates unless --send. usage: node scripts/fund-dogfood.js [--send] [--lamports N]
const fs = require("fs"); const os = require("os"); const path = require("path");
const { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const KEYS = (process.env.KEYS || path.join(os.homedir(), ".protogonos-key", "mainnet"));
const PROPOSER = (process.env.PROPOSER || path.join(KEYS, "proposer.json")).replace(/^~/, os.homedir());
const argv = process.argv.slice(2); const SEND = argv.includes("--send");
const lamports = Number(argv.includes("--lamports") ? argv[argv.indexOf("--lamports") + 1] : 10_000_000);
const state = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "mainnet-dogfood", "multisig.json"), "utf8"));
const vault = new PublicKey(state.vault0 || state.vault);
(async () => {
  const conn = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(PROPOSER, "utf8"))));
  const [pb, vb] = await Promise.all([conn.getBalance(payer.publicKey), conn.getBalance(vault)]);
  console.log("from", payer.publicKey.toBase58(), pb / LAMPORTS_PER_SOL, "-> vault0", vault.toBase58(), vb / LAMPORTS_PER_SOL, "amount", lamports / LAMPORTS_PER_SOL);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  if (!SEND) { const s = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    console.log("SIMULATION err", JSON.stringify(s.value.err), "units", s.value.unitsConsumed); process.exit(s.value.err ? 2 : 0); }
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
  const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (c.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(c.value.err)}`);
  console.log("SENT", sig, "vault0 now", (await conn.getBalance(vault)) / LAMPORTS_PER_SOL);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
