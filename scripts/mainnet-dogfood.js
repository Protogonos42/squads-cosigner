#!/usr/bin/env node
// Mainnet dogfood rig for squads-cosigner: a small 2-of-3 Squads v4 multisig
// the author controls, where the tool (Vote+Execute) is the real second
// signature. Same shape as scripts/devnet-setup.js, but real money, so every
// subcommand simulates unless --send is given.
//
//   proposer  Initiate+Vote   $PROPOSER  (64-byte JSON secret key)
//   tool      Vote+Execute    $KEYS/tool.json
//   third     Vote            $KEYS/third.json
//   createkey                 $KEYS/createkey.json (generated on first run)
//
// usage:
//   node scripts/mainnet-dogfood.js create  [--send]              # multisigCreateV2, proposer pays rent
//   node scripts/mainnet-dogfood.js propose [--send] [--lamports N] # vault0 -> proposer, self-approved by proposer
//   node scripts/mainnet-dogfood.js status                         # balances + proposal states
// env: RPC_URL, KEYS (default ~/.protogonos-key/mainnet), PROPOSER (default $KEYS/proposer.json)
// Writes fixtures/mainnet-dogfood/{multisig.json,rules.json}; never writes key material.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const sq = require("@sqds/multisig");
const lib = require("../dist/index.js");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const KEYS = (process.env.KEYS || path.join(os.homedir(), ".protogonos-key", "mainnet")).replace(/^~/, os.homedir());
const PROPOSER = (process.env.PROPOSER || path.join(KEYS, "proposer.json")).replace(/^~/, os.homedir());
const OUT = path.join(__dirname, "..", "fixtures", "mainnet-dogfood");
const STATE = path.join(OUT, "multisig.json");
const argv = process.argv.slice(2);
const cmd = argv[0];
const SEND = argv.includes("--send");
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

const loadKey = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);

async function sendOrSimulate(conn, payer, ixs, extraSigners = []) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  if (!SEND) {
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    log("SIMULATION (no --send): err", JSON.stringify(sim.value.err), "units", sim.value.unitsConsumed);
    (sim.value.logs || []).slice(-6).forEach((l) => console.log("   ", l));
    if (sim.value.err) process.exit(2);
    return null;
  }
  tx.sign([payer, ...extraSigners]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
  const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (c.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(c.value.err)}`);
  return sig;
}

function readState() {
  return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { rpc: RPC, proposals: {} };
}
function writeState(s) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const proposer = loadKey(PROPOSER);
  const tool = loadKey(path.join(KEYS, "tool.json"));
  const third = loadKey(path.join(KEYS, "third.json"));
  const ckFile = path.join(KEYS, "createkey.json");
  if (!fs.existsSync(ckFile)) fs.writeFileSync(ckFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  const createKey = loadKey(ckFile);
  const [multisigPda] = sq.getMultisigPda({ createKey: createKey.publicKey });
  const [vaultPda] = sq.getVaultPda({ multisigPda, index: 0 });
  const state = readState();
  log("multisig", multisigPda.toBase58(), "vault", vaultPda.toBase58(), SEND ? "[SEND]" : "[simulate]");

  if (cmd === "create") {
    if (await conn.getAccountInfo(multisigPda)) { log("already exists — nothing to do"); return; }
    const [programConfigPda] = sq.getProgramConfigPda({});
    const pc = await sq.accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
    log("treasury", pc.treasury.toBase58(), "creation fee", sol(pc.multisigCreationFee), "SOL; proposer balance", sol(await conn.getBalance(proposer.publicKey)));
    const { Permission, Permissions } = sq.types;
    const sig = await sendOrSimulate(conn, proposer, [
      sq.instructions.multisigCreateV2({
        treasury: pc.treasury,
        creator: proposer.publicKey,
        multisigPda,
        configAuthority: null,
        threshold: 2,
        members: [
          { key: proposer.publicKey, permissions: Permissions.fromPermissions([Permission.Initiate, Permission.Vote]) },
          { key: tool.publicKey, permissions: Permissions.fromPermissions([Permission.Vote, Permission.Execute]) },
          { key: third.publicKey, permissions: Permissions.fromPermissions([Permission.Vote]) },
        ],
        timeLock: 0,
        createKey: createKey.publicKey,
        rentCollector: proposer.publicKey,
      }),
    ], [createKey]);
    if (!sig) return;
    writeState({ ...state, rpc: RPC, multisig: multisigPda.toBase58(), vault: vaultPda.toBase58(), createKey: createKey.publicKey.toBase58(), createSignature: sig,
      members: { proposer: proposer.publicKey.toBase58(), tool: tool.publicKey.toBase58(), third: third.publicKey.toBase58() }, threshold: "2 of 3" });
    fs.writeFileSync(path.join(OUT, "rules.json"), JSON.stringify({
      $comment: "Mainnet dogfood rules: the tool co-signs only System/Token/ATA/ComputeBudget/Memo, only to the proposer, ≤0.01 SOL per proposal.",
      vault: vaultPda.toBase58(), multisig: multisigPda.toBase58(),
      allowPrograms: lib.DEFAULT_ALLOW_PROGRAMS, denyPrograms: [],
      allowDestinations: [proposer.publicKey.toBase58()], denyDestinations: [],
      maxLamportsOut: String(0.01 * LAMPORTS_PER_SOL), maxTokenOut: { "*": "0" },
      strictLookupTables: true, allowConfigTransactions: false, allowVaultTokenAccounts: false,
    }, null, 2));
    log("created", sig);
    return;
  }

  if (cmd === "propose") {
    const lamports = BigInt(arg("--lamports", String(0.005 * LAMPORTS_PER_SOL)));
    const ms = await sq.accounts.Multisig.fromAccountAddress(conn, multisigPda);
    const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;
    const [txPda] = sq.getTransactionPda({ multisigPda, index: transactionIndex });
    const [proposalPda] = sq.getProposalPda({ multisigPda, transactionIndex });
    log("index", transactionIndex.toString(), "tx", txPda.toBase58(), "proposal", proposalPda.toBase58(), "vault balance", sol(await conn.getBalance(vaultPda)), "-> proposer", sol(lamports));
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const inner = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: proposer.publicKey, lamports })] });
    const ixs = [
      sq.instructions.vaultTransactionCreate({ multisigPda, transactionIndex, creator: proposer.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: inner, memo: "squads-cosigner mainnet dogfood: vault0 -> proposer" }),
      sq.instructions.proposalCreate({ multisigPda, creator: proposer.publicKey, transactionIndex, isDraft: false }),
      sq.instructions.proposalApprove({ multisigPda, transactionIndex, member: proposer.publicKey }),
    ];
    const sig = await sendOrSimulate(conn, proposer, ixs);
    if (!sig) return;
    state.proposals = state.proposals || {};
    state.proposals[transactionIndex.toString()] = { transaction: txPda.toBase58(), proposal: proposalPda.toBase58(), lamports: lamports.toString(), createSignature: sig };
    writeState(state);
    log("proposed", sig);
    return;
  }

  if (cmd === "status") {
    log("proposer", proposer.publicKey.toBase58(), sol(await conn.getBalance(proposer.publicKey)), "| tool", tool.publicKey.toBase58(), sol(await conn.getBalance(tool.publicKey)), "| vault", sol(await conn.getBalance(vaultPda)));
    const info = await conn.getAccountInfo(multisigPda);
    if (!info) { log("multisig not created"); return; }
    const ms = await sq.accounts.Multisig.fromAccountAddress(conn, multisigPda);
    log("threshold", ms.threshold, "transactionIndex", ms.transactionIndex.toString(), "members", ms.members.length);
    for (let i = 1n; i <= BigInt(ms.transactionIndex.toString()); i++) {
      const [p] = sq.getProposalPda({ multisigPda, transactionIndex: i });
      const acc = await conn.getAccountInfo(p);
      let st = "CLOSED/absent";
      if (acc) st = Object.keys(sq.accounts.Proposal.fromAccountInfo(acc)[0].status)[0];
      log(`  #${i}`, p.toBase58(), st);
    }
    return;
  }
  console.error("usage: mainnet-dogfood.js create|propose|status [--send] [--lamports N]");
  process.exit(1);
})().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
