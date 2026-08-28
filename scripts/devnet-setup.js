#!/usr/bin/env node
// Devnet end-to-end rig for squads-cosigner.
//
// Creates (idempotently) a 2-of-3 Squads v4 multisig on devnet:
//   proposer  Initiate+Vote   (the "agent")
//   tool      Vote+Execute    (the rule-bound co-signer this repo implements)
//   third     Vote            (a bystander key; never signs here)
// funds vault 0, then creates one proposal per verdict code, each self-approved
// by the proposer so that the tool's vote alone decides the outcome. Every
// proposal's vault_transaction_create ix data is saved as an offline fixture
// under fixtures/devnet/, in the same shape as fixtures/mainnet/.
//
// Nothing here touches mainnet. Keys live outside the repo:
//   $KEYS/proposer.json $KEYS/tool.json $KEYS/third.json  (64-byte JSON arrays)
//   $KEYS/createkey.json is generated on first run (the multisig's create key).
//
// usage: RPC_URL=https://api.devnet.solana.com KEYS=~/.protogonos-key/devnet [OUT=fixtures/devnet] node scripts/devnet-setup.js [--only NAME | --fresh NAME]
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const sq = require("@squads-protocol/multisig");
const lib = require("../dist/index.js");

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const KEYS = (process.env.KEYS || path.join(os.homedir(), ".protogonos-key", "devnet")).replace(/^~/, os.homedir());
const OUT = (process.env.OUT || path.join(__dirname, "..", "fixtures", "devnet")).replace(/^~/, os.homedir());
const STATE = path.join(OUT, "multisig.json");
const TOKEN = new PublicKey(lib.TOKEN_PROGRAM);
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
// --fresh NAME: create scenario NAME again (stored as NAME-<index>) even if one exists — for daemon tests
const fresh = process.argv.includes("--fresh") ? process.argv[process.argv.indexOf("--fresh") + 1] : null;

const key = (n) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(KEYS, n), "utf8"))));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function send(conn, payer, ixs, extraSigners = []) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...extraSigners]);
  const sig = await conn.sendTransaction(tx, { maxRetries: 3 });
  const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (c.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(c.value.err)}`);
  return sig;
}

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const proposer = key("proposer.json");
  const tool = key("tool.json");
  const third = key("third.json");
  fs.mkdirSync(OUT, { recursive: true });

  const bal = await conn.getBalance(proposer.publicKey);
  log("proposer", proposer.publicKey.toBase58(), (bal / LAMPORTS_PER_SOL).toFixed(3), "SOL; tool", tool.publicKey.toBase58(), ((await conn.getBalance(tool.publicKey)) / LAMPORTS_PER_SOL).toFixed(3), "SOL");

  // 1. multisig (idempotent via a persisted create key)
  const ckFile = path.join(KEYS, "createkey.json");
  if (!fs.existsSync(ckFile)) fs.writeFileSync(ckFile, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  const createKey = key("createkey.json");
  const [multisigPda] = sq.getMultisigPda({ createKey: createKey.publicKey });
  const [vaultPda] = sq.getVaultPda({ multisigPda, index: 0 });
  let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { rpc: RPC, proposals: {} };
  if (state.multisig && state.multisig !== multisigPda.toBase58()) {
    log("state file is for another multisig", state.multisig, "— starting fresh state for", multisigPda.toBase58());
    state = { rpc: RPC, proposals: {} };
  }
  const msExists = !!(await conn.getAccountInfo(multisigPda));
  const need = msExists ? 0.02 : 0.3;
  if (bal < need * LAMPORTS_PER_SOL) throw new Error(`proposer needs ≥${need} devnet SOL (try requestAirdrop on an alternate devnet RPC, or https://faucet.solana.com)`);
  if (!msExists) {
    const [programConfigPda] = sq.getProgramConfigPda({});
    const pc = await sq.accounts.ProgramConfig.fromAccountAddress(conn, programConfigPda);
    log("creating multisig", multisigPda.toBase58(), "treasury", pc.treasury.toBase58(), "fee", pc.multisigCreationFee.toString());
    const { Permission, Permissions } = sq.types;
    const sig = await send(conn, proposer, [
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
    state = { ...state, multisig: multisigPda.toBase58(), vault: vaultPda.toBase58(), createKey: createKey.publicKey.toBase58(), createSignature: sig, members: { proposer: proposer.publicKey.toBase58(), tool: tool.publicKey.toBase58(), third: third.publicKey.toBase58() }, threshold: "2 of 3" };
    log("created", sig);
  } else log("multisig exists", multisigPda.toBase58(), "vault", vaultPda.toBase58());
  state.multisig = multisigPda.toBase58();
  state.vault = vaultPda.toBase58();
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

  // 2. fund vault 0
  const vb = await conn.getBalance(vaultPda);
  if (vb < 0.2 * LAMPORTS_PER_SOL) {
    const sig = await send(conn, proposer, [SystemProgram.transfer({ fromPubkey: proposer.publicKey, toPubkey: vaultPda, lamports: 0.3 * LAMPORTS_PER_SOL })]);
    log("funded vault 0.3 SOL", sig);
  } else log("vault holds", (vb / LAMPORTS_PER_SOL).toFixed(3), "SOL");

  // 3. rules for this devnet vault
  const rulesFile = path.join(OUT, "rules.json");
  const rules = {
    $comment: "Devnet rig rules: the tool co-signs only System/Token/ATA/ComputeBudget/Memo, only to the proposer, ≤0.1 SOL per proposal.",
    vault: vaultPda.toBase58(),
    multisig: multisigPda.toBase58(),
    allowPrograms: lib.DEFAULT_ALLOW_PROGRAMS,
    denyPrograms: [],
    allowDestinations: [proposer.publicKey.toBase58()],
    denyDestinations: [],
    maxLamportsOut: String(0.1 * LAMPORTS_PER_SOL),
    maxTokenOut: { "*": "1000000000" },
    strictLookupTables: true,
    allowConfigTransactions: false,
    allowVaultTokenAccounts: true,
  };
  fs.writeFileSync(rulesFile, JSON.stringify(rules, null, 2));

  // 4. one proposal per verdict code
  const stranger = Keypair.generate().publicKey;
  const scenarios = [
    { name: "approve-transfer", expect: "APPROVE", ixs: () => [SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: proposer.publicKey, lamports: 0.01 * LAMPORTS_PER_SOL })] },
    { name: "counterparty-stranger", expect: "REFUSED_COUNTERPARTY", ixs: () => [SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: stranger, lamports: 0.01 * LAMPORTS_PER_SOL })] },
    { name: "over-cap", expect: "REFUSED_OVER_CAP", ixs: () => [SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: proposer.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL })] },
    { name: "theft-assign", expect: "REFUSED_THEFT_SHAPED", ixs: () => [SystemProgram.assign({ accountPubkey: vaultPda, programId: stranger })] },
    {
      name: "mint-create",
      expect: "REFUSED_MINT_CUSTODY",
      ephemeralSigners: 1,
      ixs: (transactionPda) => {
        const [mint] = sq.getEphemeralSignerPda({ transactionPda, ephemeralSignerIndex: 0 });
        const data = Buffer.alloc(1 + 1 + 32 + 1);
        data[0] = 20; // InitializeMint2
        data[1] = 6;
        vaultPda.toBuffer().copy(data, 2);
        data[34] = 0; // no freeze authority
        return [
          SystemProgram.createAccount({ fromPubkey: vaultPda, newAccountPubkey: mint, lamports: 1461600, space: 82, programId: TOKEN }),
          { programId: TOKEN, keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data },
        ];
      },
    },
    { name: "unknown-program", expect: "REFUSED_UNSCREENABLE", ixs: () => [{ programId: stranger, keys: [{ pubkey: vaultPda, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) }] },
    { name: "config-add-member", expect: "REFUSED_CONFIG_CHANGE", config: () => [{ __kind: "AddMember", newMember: { key: stranger, permissions: sq.types.Permissions.all() } }] },
  ];

  for (const s of scenarios) {
    if (fresh && s.name !== fresh) continue;
    if (only && s.name !== only) continue;
    if (!fresh && state.proposals[s.name]) {
      log("exists", s.name, "index", state.proposals[s.name].transactionIndex);
      continue;
    }
    const ms = await sq.accounts.Multisig.fromAccountAddress(conn, multisigPda);
    const transactionIndex = sq.utils.toBigInt(ms.transactionIndex) + 1n;
    const [transactionPda] = sq.getTransactionPda({ multisigPda, index: transactionIndex });
    const [proposalPda] = sq.getProposalPda({ multisigPda, transactionIndex });
    let createIx;
    if (s.config) {
      createIx = sq.instructions.configTransactionCreate({ multisigPda, transactionIndex, creator: proposer.publicKey, actions: s.config(), memo: s.name });
    } else {
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const inner = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: blockhash, instructions: s.ixs(transactionPda) });
      createIx = sq.instructions.vaultTransactionCreate({ multisigPda, transactionIndex, creator: proposer.publicKey, vaultIndex: 0, ephemeralSigners: s.ephemeralSigners ?? 0, transactionMessage: inner, memo: s.name });
    }
    const sig = await send(conn, proposer, [
      createIx,
      sq.instructions.proposalCreate({ multisigPda, creator: proposer.publicKey, transactionIndex }),
      sq.instructions.proposalApprove({ multisigPda, transactionIndex, member: proposer.publicKey }),
    ]);
    const label = fresh ? `${s.name}-${transactionIndex}` : s.name;
    const fixture = {
      network: "devnet",
      scenario: label,
      expectedVerdict: s.expect,
      kind: s.config ? "ConfigTransaction" : "VaultTransaction",
      multisig: multisigPda.toBase58(),
      vault: vaultPda.toBase58(),
      transactionIndex: transactionIndex.toString(),
      transactionPda: transactionPda.toBase58(),
      proposalPda: proposalPda.toBase58(),
      createSignature: sig,
      programId: sq.PROGRAM_ID.toBase58(),
      accounts: createIx.keys.map((k) => k.pubkey.toBase58()),
      ixDataBase64: Buffer.from(createIx.data).toString("base64"),
      fetchedAt: new Date().toISOString(),
      rpc: RPC,
    };
    fs.writeFileSync(path.join(OUT, fresh ? `fresh-${label}.json` : `${s.name}.json`), JSON.stringify(fixture, null, 2));
    state.proposals[label] = { transactionIndex: fixture.transactionIndex, proposalPda: fixture.proposalPda, expectedVerdict: s.expect, createSignature: sig };
    fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
    log("proposal", label, "index", transactionIndex.toString(), proposalPda.toBase58(), sig);
  }
  log("done. rules:", rulesFile);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
