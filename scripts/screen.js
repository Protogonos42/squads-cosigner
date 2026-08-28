#!/usr/bin/env node
// screen.js — a read-only treasury screen for a Squads v4 multisig.
//
// Walks every transaction index the multisig has ever used, recovers the
// create instruction from signature history (so CLOSED proposals whose
// accounts were reclaimed are still decoded), decodes the inner message,
// derives an "observed" rules.json from what the treasury actually did, and
// evaluates every proposal against it. Writes a markdown report and the
// rules file. Needs only the address; never a key.
//
// usage: node scripts/screen.js <multisig> [--from N] [--to N] [--out DIR] [--rpc URL]
const fs = require("fs");
const path = require("path");
const { Connection, PublicKey } = require("@solana/web3.js");
const sq = require("@sqds/multisig");
const lib = require("../dist/index.js");

const RPC = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const PROGRAM = sq.PROGRAM_ID;
const D = (k) => Buffer.from(sq.generated[k]);
const DISC = {
  vaultCreate: D("vaultTransactionCreateInstructionDiscriminator"),
  configCreate: D("configTransactionCreateInstructionDiscriminator"),
  vaultExecute: D("vaultTransactionExecuteInstructionDiscriminator"),
  configExecute: D("configTransactionExecuteInstructionDiscriminator"),
  approve: D("proposalApproveInstructionDiscriminator"),
  reject: D("proposalRejectInstructionDiscriminator"),
  cancel: D("proposalCancelInstructionDiscriminator"),
  close: D("vaultTransactionAccountsCloseInstructionDiscriminator"),
  batchCreate: D("batchCreateInstructionDiscriminator"),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : "—");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

async function withRetry(fn, tries = 5) {
  let wait = 500;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(wait);
      wait *= 2;
    }
  }
}

function squadsIxs(tx) {
  const msg = tx.transaction.message;
  const keys = msg.staticAccountKeys ?? msg.accountKeys;
  const ixs = msg.compiledInstructions ?? msg.instructions;
  const out = [];
  for (const ix of ixs) {
    const pid = keys[ix.programIdIndex];
    if (!pid || !pid.equals(PROGRAM)) continue;
    const data = Buffer.from(ix.data);
    const accIdx = ix.accountKeyIndexes ?? ix.accounts;
    out.push({ data, accounts: accIdx.map((i) => keys[i] && keys[i].toBase58()), signer: keys[0].toBase58() });
  }
  return out;
}

function which(data) {
  const d8 = data.subarray(0, 8);
  for (const [k, v] of Object.entries(DISC)) if (d8.equals(v)) return k;
  return null;
}

async function historyForIndex(conn, multisigPda, index, delay) {
  const { transactionPda, proposalPda } = lib.pdas(multisigPda, BigInt(index));
  const sigs = await withRetry(() => conn.getSignaturesForAddress(transactionPda, { limit: 40 }));
  await sleep(delay);
  const events = [];
  let create = null;
  for (const s of [...sigs].reverse()) {
    const tx = await withRetry(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
    await sleep(delay);
    if (!tx) continue;
    for (const ix of squadsIxs(tx)) {
      const kind = which(ix.data);
      if (!kind) continue;
      events.push({ kind, signature: s.signature, blockTime: tx.blockTime, err: s.err, signer: ix.signer });
      if (!create && (kind === "vaultCreate" || kind === "configCreate" || kind === "batchCreate")) {
        create = { kind, data: ix.data, accounts: ix.accounts, signature: s.signature, blockTime: tx.blockTime, creator: ix.signer };
      }
    }
  }
  // live proposal account, if still there
  let live = null;
  const info = await withRetry(() => conn.getAccountInfo(proposalPda));
  await sleep(delay);
  if (info) {
    try {
      live = lib.decodeProposal(info.data);
    } catch {}
  }
  return { index, transactionPda: transactionPda.toBase58(), proposalPda: proposalPda.toBase58(), create, events, live, sigCount: sigs.length };
}

function inferStatus(h) {
  if (h.live) return { status: h.live.status.kind, source: "proposal account" };
  const k = new Set(h.events.filter((e) => !e.err).map((e) => e.kind));
  if (k.has("vaultExecute") || k.has("configExecute")) return { status: "Executed", source: "execute signature" };
  if (k.has("cancel")) return { status: "Cancelled", source: "cancel signature" };
  if (k.has("close")) return { status: "Closed (unexecuted)", source: "accounts-close signature" };
  if (k.has("reject")) return { status: "Rejected?", source: "reject signature, account gone" };
  if (!h.create) return { status: "Unknown", source: `no create found in ${h.sigCount} signatures` };
  return { status: "Gone", source: "account reclaimed, no execute seen" };
}

function collectObserved(msg, vault, obs) {
  for (const ix of msg.instructions) {
    const unresolved = ix.programId.startsWith("<"); // placeholder for an unresolved lookup-table key
    if (!unresolved) obs.programs.add(ix.programId);
    const d = ix.explain?.detail || {};
    const to = d.to ?? d.destination ?? d.newAccount ?? d.ata ?? d.stakePool ?? null;
    if (to && to !== vault && !String(to).startsWith("<")) obs.destinations.add(to);
    if (ix.explain?.op === "unknown" && !unresolved) obs.unknownPrograms.add(ix.programId);
    if (ix.explain?.op === "malformed") obs.malformed++;
  }
  if (msg.addressTableLookups?.length) obs.withLookupTables++;
}

(async () => {
  const a = parseArgs(process.argv.slice(2));
  const msArg = a._[0];
  if (!msArg) {
    console.error("usage: screen.js <multisig> [--from N] [--to N] [--out DIR] [--rpc URL] [--delay MS]");
    process.exit(2);
  }
  const rpc = a.rpc || RPC;
  const delay = Number(a.delay || 250);
  const conn = new Connection(rpc, "confirmed");
  const multisigPda = new PublicKey(msArg);
  const msInfo = await withRetry(() => conn.getAccountInfo(multisigPda));
  if (!msInfo) throw new Error("multisig account not found");
  const ms = lib.decodeMultisig(msInfo.data, multisigPda);
  const vault = ms.vault0 ?? lib.pdas(multisigPda, 0n).vaultPda?.toBase58?.() ?? sq.getVaultPda({ multisigPda, index: 0 })[0].toBase58();
  const latest = Number(ms.transactionIndex);
  const from = Number(a.from || 1);
  const to = Number(a.to || latest);
  const outDir = a.out || path.join("screens", multisigPda.toBase58().slice(0, 8));
  fs.mkdirSync(outDir, { recursive: true });
  console.error(`multisig ${multisigPda.toBase58()} vault ${vault} threshold ${ms.threshold}/${ms.members.length} indices ${from}..${to}`);

  const obs = { programs: new Set(), destinations: new Set(), unknownPrograms: new Set(), malformed: 0, withLookupTables: 0 };
  const rows = [];
  for (let i = from; i <= to; i++) {
    const h = await historyForIndex(conn, multisigPda, i, delay);
    const st = inferStatus(h);
    let decoded = null;
    let kind = h.create?.kind ?? "?";
    if (h.create?.kind === "vaultCreate") {
      try {
        decoded = lib.decodeVaultTransactionCreateIx(h.create.data);
        collectObserved(decoded.message, vault, obs);
      } catch (e) {
        decoded = { error: String(e) };
      }
    } else if (h.create?.kind === "configCreate") {
      try {
        const [args] = sq.generated.configTransactionCreateStruct.deserialize(h.create.data);
        decoded = { configActions: args.args.actions.map((x) => x.__kind), memo: args.args.memo };
      } catch (e) {
        decoded = { error: String(e) };
      }
    }
    rows.push({ ...h, status: st, decoded, kind });
    console.error(`  #${i} ${kind} ${st.status} (${h.events.length} events)`);
  }

  // observed rules: what this treasury has actually done
  const rules = {
    $comment: `Generated by squads-cosigner screen.js on ${new Date().toISOString()} from indices ${from}..${to} of ${multisigPda.toBase58()}. Review before use: an allowlist built from history permits everything history contains, including anything you would now refuse.`,
    vault,
    allowPrograms: [...obs.programs].sort(),
    denyPrograms: ["BPFLoaderUpgradeab1e11111111111111111111111"],
    allowDestinations: [...obs.destinations].sort(),
    denyDestinations: [],
    strictLookupTables: true,
    allowConfigTransactions: false,
    allowVaultTokenAccounts: true,
  };
  const validated = lib.validateRules(rules);
  const members = ms.members.map((m) => m.key);

  const verdicts = {};
  for (const r of rows) {
    if (r.decoded?.message) {
      const ev = lib.evaluateVaultMessage(r.decoded.message, validated, { members });
      r.evaluation = ev;
    } else if (r.decoded?.configActions) {
      r.evaluation = { verdict: "REFUSED_CONFIG_CHANGE", reasons: [{ rule: "allowConfigTransactions=false", instruction: null, detail: `ConfigTransaction with actions [${r.decoded.configActions.join(", ")}]` }], lamportsOut: "0", tokenOut: {} };
    } else {
      r.evaluation = { verdict: "REFUSED_UNSCREENABLE", reasons: [{ rule: "decode", instruction: null, detail: r.decoded?.error || "create instruction not found" }], lamportsOut: "0", tokenOut: {} };
    }
    verdicts[r.evaluation.verdict] = (verdicts[r.evaluation.verdict] || 0) + 1;
  }

  // anomalies
  const anomalies = [];
  const executedRefused = rows.filter((r) => r.status.status === "Executed" && r.evaluation.verdict !== "APPROVE");
  const stillActive = rows.filter((r) => r.live && ["Active", "Draft", "Approved"].includes(r.live.status.kind));
  const configTxs = rows.filter((r) => r.kind === "configCreate");
  const seenOnce = [...obs.destinations].filter((d) => rows.filter((r) => JSON.stringify(r.decoded || "").includes(d)).length === 1);
  if (obs.unknownPrograms.size) anomalies.push(`${obs.unknownPrograms.size} program(s) the decoder cannot read were called: ${[...obs.unknownPrograms].map(short).join(", ")}. A rule-bound co-signer would refuse these as UNSCREENABLE until a decoder exists for them.`);
  if (obs.withLookupTables) anomalies.push(`${obs.withLookupTables} proposal(s) reference address lookup tables. If a table is mutable, its owner can change what the proposal does after members approve it.`);
  if (configTxs.length) anomalies.push(`${configTxs.length} config transaction(s) — membership/threshold/time-lock changes: ${configTxs.map((r) => `#${r.index} [${(r.decoded?.configActions || []).join(", ")}] ${r.status.status}`).join("; ")}.`);
  if (stillActive.length) anomalies.push(`${stillActive.length} proposal(s) still open: ${stillActive.map((r) => `#${r.index} ${r.live.status.kind}`).join(", ")}. Each holds ~0.0077 SOL of rent until closed.`);
  if (seenOnce.length) anomalies.push(`${seenOnce.length} destination(s) appeared in exactly one proposal: ${seenOnce.map(short).join(", ")}.`);
  if (executedRefused.length) anomalies.push(`${executedRefused.length} executed proposal(s) the observed rules would still refuse (see table) — these are the shapes you must decide about before a co-signer goes live.`);

  const md = [];
  md.push(`# Treasury screen — ${multisigPda.toBase58()}`);
  md.push(``);
  md.push(`Generated ${new Date().toISOString()} by [squads-cosigner](https://github.com/Protogonos42/squads-cosigner) \`scripts/screen.js\`, read-only, from public chain state via \`${rpc}\`. Written by an AI agent (Protogonos); verify anything you act on.`);
  md.push(``);
  md.push(`## Configuration`);
  md.push(``);
  md.push(`| | |`);
  md.push(`|---|---|`);
  md.push(`| Vault (index 0) | \`${vault}\` |`);
  md.push(`| Threshold | ${ms.threshold} of ${ms.members.length} |`);
  md.push(`| Time-lock | ${ms.timeLock}s |`);
  md.push(`| Config authority | ${ms.configAuthority ? `\`${ms.configAuthority}\` — **one key can change the rules without a vote**` : "none (changes need a config proposal)"} |`);
  md.push(`| Rent collector | ${ms.rentCollector ? `\`${ms.rentCollector}\`` : "none — closed proposals' rent is unrecoverable"} |`);
  md.push(`| Transactions so far | ${latest} (screened ${from}..${to}) |`);
  md.push(``);
  md.push(`### Members`);
  md.push(``);
  md.push(`| Key | Initiate | Vote | Execute | Meaning |`);
  md.push(`|---|:-:|:-:|:-:|---|`);
  for (const m of ms.members) {
    const p = m.permissions;
    let meaning = [];
    if (p.initiate && p.vote && p.execute) meaning.push("full member: can propose, approve and execute alone if threshold allows");
    else if (p.initiate && !p.vote) meaning.push("proposer only — cannot approve what it proposes");
    else if (!p.initiate && p.vote && !p.execute) meaning.push("approver only — cannot propose or execute");
    else if (!p.initiate && p.vote && p.execute) meaning.push("co-signer/executor — approves and executes, never proposes");
    else if (p.initiate && p.vote && !p.execute) meaning.push("proposes and approves, cannot execute");
    else meaning.push("—");
    md.push(`| \`${m.key}\` | ${p.initiate ? "✓" : ""} | ${p.vote ? "✓" : ""} | ${p.execute ? "✓" : ""} | ${meaning.join("")} |`);
  }
  const votersNeeded = ms.threshold;
  const voters = ms.members.filter((m) => m.permissions.vote).length;
  md.push(``);
  md.push(`${voters} member(s) can vote; ${votersNeeded} approval(s) execute a proposal.${voters === votersNeeded ? " **Every voter is required — losing one key freezes the treasury.**" : ""}`);
  md.push(``);
  md.push(`## Proposal history`);
  md.push(``);
  md.push(`| # | Created | Type | Status | Instructions | Verdict under observed rules | Lamports out | Note |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const when = r.create?.blockTime ? new Date(r.create.blockTime * 1000).toISOString().slice(0, 10) : "?";
    const type = r.kind === "vaultCreate" ? "vault" : r.kind === "configCreate" ? "config" : r.kind;
    const ixs = r.decoded?.message ? r.decoded.message.instructions.map((ix) => (ix.explain?.op && ix.explain.op !== "unknown" ? ix.explain.op : `${ix.programName || short(ix.programId)}.unknown`)).join("<br>") : r.decoded?.configActions ? r.decoded.configActions.join("<br>") : "—";
    const note = r.evaluation.reasons.map((x) => x.detail).join("; ").slice(0, 160);
    md.push(`| ${r.index} | ${when} | ${type} | ${r.status.status} | ${ixs} | \`${r.evaluation.verdict}\` | ${r.evaluation.lamportsOut} | ${note} |`);
  }
  md.push(``);
  md.push(`Verdict counts: ${Object.entries(verdicts).map(([k, v]) => `\`${k}\` ${v}`).join(", ")}.`);
  md.push(``);
  md.push(`## Things to look at`);
  md.push(``);
  if (anomalies.length) for (const x of anomalies) md.push(`- ${x}`);
  else md.push(`- Nothing stood out in ${rows.length} proposals.`);
  md.push(``);
  md.push(`## Observed rules`);
  md.push(``);
  md.push(`\`rules.observed.json\` beside this file allows exactly the programs and destinations this treasury has used (${obs.programs.size} programs, ${obs.destinations.size} destinations), refuses config changes and mutable lookup tables, and sets no caps. Against the ${rows.length} proposals screened it approves ${verdicts.APPROVE || 0} and refuses ${rows.length - (verdicts.APPROVE || 0)}; every refusal is in the table with its reason. **It is a starting point, not a policy**: tighten destinations to the ones you still pay, add \`maxLamportsOut\`/\`maxTokenOut\` caps, and decide about each refused-but-executed row.`);
  md.push(``);
  md.push(`## Method`);
  md.push(``);
  md.push(`For each index the create instruction was recovered from the transaction PDA's signature history, so proposals whose accounts have been closed are still decoded from the bytes members actually approved. Status comes from the live proposal account where it exists, otherwise from execute/cancel/close signatures. Instructions are decoded by the same engine the co-signer uses; anything it cannot positively interpret is reported as \`REFUSED_UNSCREENABLE\`, never guessed.`);

  fs.writeFileSync(path.join(outDir, "report.md"), md.join("\n") + "\n");
  fs.writeFileSync(path.join(outDir, "rules.observed.json"), JSON.stringify(rules, null, 2) + "\n");
  fs.writeFileSync(path.join(outDir, "history.json"), JSON.stringify(rows.map((r) => ({ ...r, create: r.create && { ...r.create, data: r.create.data.toString("base64") } })), (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.error(`wrote ${outDir}/report.md, rules.observed.json, history.json`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
