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
// usage: node scripts/screen.js <multisig|vault|program> [--from N] [--to N] [--out DIR] [--rpc URL]
const fs = require("fs");
const path = require("path");
const { Connection, PublicKey } = require("@solana/web3.js");
const sq = require("@sqds/multisig");
const lib = require("../dist/index.js");

const KNOWN_MINTS = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: ["USDC", 6], Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCdtjyeuz4W: ["USDT", 6], So11111111111111111111111111111111111111112: ["wSOL", 9] };
const PERIODS = ["OneTime", "Day", "Week", "Month"];
const shortKey = (k) => (k ? `${String(k).slice(0, 4)}…${String(k).slice(-4)}` : "?");
function fmtAmount(mint, amount) {
  const m = KNOWN_MINTS[mint];
  const raw = BigInt(String(amount));
  if (!m) return `${raw} raw of ${shortKey(mint)}`;
  const d = 10n ** BigInt(m[1]);
  const whole = raw / d, frac = (raw % d).toString().padStart(m[1], "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${m[0]}`;
}
function permString(mask) {
  const p = [];
  if (mask & 1) p.push("initiate");
  if (mask & 2) p.push("vote");
  if (mask & 4) p.push("execute");
  return p.length ? p.join("+") : "none";
}
// One line per config action, with its arguments. The action name alone hides
// the thing that matters (which key, how much, to whom), so say it.
function describeConfigAction(x) {
  const k = x.__kind;
  switch (k) {
    case "AddMember": return `AddMember ${shortKey(x.newMember?.key?.toBase58?.() ?? x.newMember?.key)} (${permString(x.newMember?.permissions?.mask ?? 0)})`;
    case "RemoveMember": return `RemoveMember ${shortKey(x.oldMember?.toBase58?.() ?? x.oldMember)}`;
    case "ChangeThreshold": return `ChangeThreshold → ${x.newThreshold}`;
    case "SetTimeLock": return `SetTimeLock → ${x.newTimeLock}s`;
    case "AddSpendingLimit": {
      const mint = x.mint?.toBase58?.() ?? String(x.mint);
      const members = (x.members || []).map((m) => shortKey(m.toBase58?.() ?? m)).join(",");
      const dests = (x.destinations || []).map((m) => shortKey(m.toBase58?.() ?? m));
      return `AddSpendingLimit vault ${x.vaultIndex}: ${fmtAmount(mint, x.amount)} per ${PERIODS[x.period] ?? x.period}, member(s) ${members || "?"} → ${dests.length ? dests.join(",") : "any destination"}`;
    }
    case "RemoveSpendingLimit": return `RemoveSpendingLimit ${shortKey(x.spendingLimit?.toBase58?.() ?? x.spendingLimit)}`;
    case "SetRentCollector": return `SetRentCollector → ${x.newRentCollector ? shortKey(x.newRentCollector.toBase58?.() ?? x.newRentCollector) : "none"}`;
    default: return k;
  }
}
// Live SpendingLimit accounts for this multisig (getProgramAccounts; some public
// RPCs refuse it — then we say so rather than claim there are none).
async function fetchSpendingLimits(conn, multisigPda) {
  const disc = Buffer.from(sq.generated.spendingLimitDiscriminator);
  const accs = await conn.getProgramAccounts(sq.PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: require("bs58").encode(disc) } }, { memcmp: { offset: 8, bytes: multisigPda.toBase58() } }],
  });
  return accs.map(({ pubkey, account }) => {
    const [s] = sq.accounts.SpendingLimit.fromAccountInfo(account);
    return {
      address: pubkey.toBase58(),
      vaultIndex: s.vaultIndex,
      mint: s.mint.toBase58(),
      amount: String(sq.utils.toBigInt(s.amount)),
      remaining: String(sq.utils.toBigInt(s.remainingAmount)),
      period: PERIODS[s.period] ?? String(s.period),
      members: s.members.map((m) => m.toBase58()),
      destinations: s.destinations.map((m) => m.toBase58()),
    };
  });
}

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

// Resolve every address lookup table the inner message references, cached
// per table address so a treasury that reuses one table costs one RPC call.
// Tables that no longer exist are left unresolved (the rules then refuse).

// Accept a multisig, one of its vault PDAs, or an upgradeable program whose
// authority is such a vault. Anything that is not a Squads-owned Multisig
// account is resolved back to its parent multisig from public chain state:
// program -> ProgramData.authority -> vault; vault -> the Squads-owned
// account of size 132 + 33*n in a recent Squads transaction whose
// derived vault (index 0..255) equals the address. Says what it did on
// stderr so a reader can check the chain of custody.
const BPF_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
async function resolveMultisig(conn, pk, delay) {
  const info = await withRetry(() => conn.getAccountInfo(pk));
  if (!info) throw new Error(`account ${pk.toBase58()} not found`);
  if (info.owner.equals(PROGRAM)) return { multisigPda: pk, info, via: [] };
  const via = [];
  if (info.owner.equals(BPF_LOADER)) {
    const parsed = await withRetry(() => conn.getParsedAccountInfo(pk));
    const pdAddr = parsed.value?.data?.parsed?.info?.programData;
    if (!pdAddr) throw new Error(`${pk.toBase58()} is loader-owned but has no programData (a buffer or ProgramData account?)`);
    await sleep(delay);
    const pd = await withRetry(() => conn.getParsedAccountInfo(new PublicKey(pdAddr)));
    const auth = pd.value?.data?.parsed?.info?.authority;
    if (!auth) throw new Error(`program ${pk.toBase58()} has no upgrade authority (immutable)`);
    via.push(`program ${pk.toBase58()} -> ProgramData ${pdAddr} -> authority ${auth}`);
    pk = new PublicKey(auth);
    await sleep(delay);
    const ai = await withRetry(() => conn.getAccountInfo(pk));
    if (ai && ai.owner.equals(PROGRAM)) return { multisigPda: pk, info: ai, via };
    if (PublicKey.isOnCurve(pk.toBytes())) throw new Error(`upgrade authority ${pk.toBase58()} is an on-curve key, not a Squads vault: ${via.join("; ")}`);
  } else if (PublicKey.isOnCurve(pk.toBytes())) {
    throw new Error(`${pk.toBase58()} is an on-curve key (owner ${info.owner.toBase58()}), not a multisig, vault or program`);
  }
  // pk is an off-curve PDA: look for the multisig it belongs to.
  const sigs = await withRetry(() => conn.getSignaturesForAddress(pk, { limit: 50 }));
  const seen = new Set();
  for (const s of sigs) {
    await sleep(delay);
    const tx = await withRetry(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }));
    if (!tx) continue;
    const keys = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys;
    if (!keys.some((k) => k.equals(PROGRAM))) continue;
    for (const k of keys) {
      const b = k.toBase58();
      if (seen.has(b) || k.equals(PROGRAM)) continue;
      seen.add(b);
      await sleep(delay);
      const ai = await withRetry(() => conn.getAccountInfo(k));
      if (!ai || !ai.owner.equals(PROGRAM) || (ai.data.length - 132) % 33 !== 0 || ai.data.length < 165) continue;
      for (let i = 0; i < 256; i++) {
        if (sq.getVaultPda({ multisigPda: k, index: i })[0].equals(pk)) {
          via.push(`vault ${pk.toBase58()} = vault ${i} of multisig ${b} (found in tx ${s.signature.slice(0, 12)}…)`);
          return { multisigPda: k, info: ai, via };
        }
      }
    }
  }
  throw new Error(`${pk.toBase58()} is an off-curve PDA but no Squads multisig deriving it was found in its last ${sigs.length} transactions: ${via.join("; ") || "no program hop"}`);
}

const lutCache = new Map();
async function resolveTables(conn, innerBytes, delay) {
  const raw = lib.parseCompactVaultMessage(innerBytes);
  if (!raw.addressTableLookups?.length) return null;
  const tables = new Map();
  for (const l of raw.addressTableLookups) {
    const k = l.accountKey.toBase58();
    if (!lutCache.has(k)) {
      await sleep(delay);
      const { value } = await withRetry(() => conn.getAddressLookupTable(l.accountKey));
      lutCache.set(k, value ? { addresses: value.state.addresses.map((x) => x.toBase58()), frozen: value.state.authority == null } : null);
    }
    const t = lutCache.get(k);
    if (t) tables.set(k, t.addresses);
  }
  return tables;
}

// Optional program-name file (--names FILE): { "<programId>": { "name": "...",
// "instructions": { "<8-byte discriminator hex>": "approveMint", ... } } }.
// Names an instruction the built-in decoder does not know, by discriminator
// only — arguments are NOT decoded and no flags are set. This makes the report
// readable for a treasury whose proposals are all calls into its own program;
// it does not make those calls safe, and the report says so.
function applyNames(msg, names, obs) {
  if (!names) return;
  for (const ix of msg.instructions) {
    const p = names[ix.programId];
    if (!p || ix.explain?.op !== "unknown") continue;
    const disc = (ix.dataHex || "").slice(0, 16);
    const ixName = p.instructions?.[disc];
    ix.programName = p.name;
    if (ixName) {
      ix.explain = { op: `${p.name}.${ixName}`, detail: { namedBy: "discriminator", argsDecoded: false }, flags: {} };
      obs.namedByFile++;
    }
  }
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
    console.error("usage: screen.js <multisig|vault|program> [--from N] [--to N] [--out DIR] [--rpc URL] [--delay MS] [--names FILE] [--no-luts]");
    process.exit(2);
  }
  const rpc = a.rpc || RPC;
  const delay = Number(a.delay || 250);
  const conn = new Connection(rpc, "confirmed");
  const resolved = await resolveMultisig(conn, new PublicKey(msArg), delay);
  const multisigPda = resolved.multisigPda;
  const msInfo = resolved.info;
  for (const v of resolved.via) console.error(`resolved: ${v}`);
  const ms = lib.decodeMultisig(msInfo.data, multisigPda);
  const vault = ms.vault0 ?? lib.pdas(multisigPda, 0n).vaultPda?.toBase58?.() ?? sq.getVaultPda({ multisigPda, index: 0 })[0].toBase58();
  const latest = Number(ms.transactionIndex);
  const from = Number(a.from || 1);
  const to = Number(a.to || latest);
  const outDir = a.out || path.join("screens", multisigPda.toBase58().slice(0, 8));
  fs.mkdirSync(outDir, { recursive: true });
  console.error(`multisig ${multisigPda.toBase58()} vault ${vault} threshold ${ms.threshold}/${ms.members.length} indices ${from}..${to}`);
  let spendingLimits = null; // null = could not list; [] = listed, none
  try {
    spendingLimits = await withRetry(() => fetchSpendingLimits(conn, multisigPda));
    console.error(`  spending limits live: ${spendingLimits.length}`);
  } catch (e) {
    console.error(`  spending limits: could not list (${String(e).slice(0, 80)})`);
  }

  const names = a.names ? JSON.parse(fs.readFileSync(a.names, "utf8")) : null;
  const obs = { programs: new Set(), destinations: new Set(), unknownPrograms: new Set(), malformed: 0, withLookupTables: 0, namedByFile: 0, mutableTables: new Set() };
  const rows = [];
  for (let i = from; i <= to; i++) {
    const h = await historyForIndex(conn, multisigPda, i, delay);
    const st = inferStatus(h);
    let decoded = null;
    let kind = h.create?.kind ?? "?";
    if (h.create?.kind === "vaultCreate") {
      try {
        decoded = lib.decodeVaultTransactionCreateIx(h.create.data);
        if (decoded.message.addressTableLookups?.length && !a["no-luts"]) {
          const tables = await resolveTables(conn, decoded.innerMessageBytes, delay);
          if (tables?.size) decoded = lib.decodeVaultTransactionCreateIx(h.create.data, tables);
          decoded.lookupTables = decoded.message.addressTableLookups.map((l) => ({ table: l.table, resolved: tables?.has(l.table) ?? false, frozen: lutCache.get(l.table)?.frozen ?? null }));
          for (const t of decoded.lookupTables) if (t.resolved && t.frozen === false) obs.mutableTables.add(t.table);
        }
        applyNames(decoded.message, names, obs);
        collectObserved(decoded.message, vault, obs);
      } catch (e) {
        decoded = { error: String(e) };
      }
    } else if (h.create?.kind === "configCreate") {
      try {
        const [args] = sq.generated.configTransactionCreateStruct.deserialize(h.create.data);
        decoded = { configActions: args.args.actions.map((x) => x.__kind), configDetails: args.args.actions.map(describeConfigAction), memo: args.args.memo };
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
  if (obs.withLookupTables) anomalies.push(`${obs.withLookupTables} proposal(s) reference address lookup tables${a["no-luts"] ? " (not resolved: --no-luts)" : `; ${lutCache.size} distinct table(s) fetched, ${[...lutCache.values()].filter((t) => t).length} still exist`}. ${obs.mutableTables.size ? `**${obs.mutableTables.size} of them are MUTABLE** (${[...obs.mutableTables].map(short).join(", ")}): the table's authority can change what an approved proposal does before it executes.` : "Every table that still exists is frozen (no authority), so its contents cannot change after approval."}`);
  if (obs.namedByFile) anomalies.push(`${obs.namedByFile} instruction(s) were named from \`--names ${path.basename(a.names)}\` by discriminator only: the report can say *which* instruction of that program was called, but arguments were not decoded and the rule engine treats the call as interpretable solely because the program is allow-listed. Do not read a named row as a safe row.`);
  if (configTxs.length) anomalies.push(`${configTxs.length} config transaction(s) — membership/threshold/time-lock changes: ${configTxs.map((r) => `#${r.index} [${(r.decoded?.configDetails || r.decoded?.configActions || []).join(", ")}] ${r.status.status}`).join("; ")}.`);
  const nonMemberLimits = (spendingLimits || []).filter((s) => !s.members.every((m) => ms.members.some((x) => x.key === m)));
  if (nonMemberLimits.length) anomalies.push(`${nonMemberLimits.length} live spending limit(s) whose spender is not a multisig member: ${nonMemberLimits.map((s) => `${fmtAmount(s.mint, s.amount)}/${s.period} by ${s.members.map(shortKey).join(",")}`).join("; ")}. Remove with a RemoveSpendingLimit proposal if unintended.`);
  if (stillActive.length) {
    // For each open proposal: how close it is to executing, how many rejections would kill it,
    // and whether the loader accounts it touches (buffers to close / upgrade from) still exist.
    const votingMembers = ms.members.filter((m) => m.permissions.vote).length;
    const toKill = votingMembers - ms.threshold + 1; // Squads v4: rejected when rejections > members - threshold
    const parts = [];
    for (const r of stillActive) {
      const approved = r.live.approved?.length ?? 0;
      const rejected = r.live.rejected?.length ?? 0;
      let line = `#${r.index} ${r.live.status.kind} (${approved}/${ms.threshold} approvals, ${rejected}/${toKill} rejections needed to kill)`;
      const loaderIxs = (r.decoded?.message?.instructions || []).filter((ix) => ix.explain?.op?.startsWith("bpf-upgradeable-loader."));
      const targets = new Map();
      for (const ix of loaderIxs) {
        const d = ix.explain.detail || {};
        const t = ix.explain.op.endsWith(".upgrade") ? d.buffer : d.account || d.programData;
        if (t) targets.set(t, ix.explain.op.split(".")[1]);
      }
      if (targets.size) {
        const states = [];
        let lamports = 0n, gone = 0;
        for (const [t] of targets) {
          try {
            const info = await withRetry(() => conn.getAccountInfo(new PublicKey(t)));
            await sleep(delay);
            if (!info) { gone++; states.push(`${short(t)} GONE`); }
            else { lamports += BigInt(info.lamports); states.push(`${short(t)} ${(info.lamports / 1e9).toFixed(3)} SOL`); }
          } catch (e) { states.push(`${short(t)} ?`); }
        }
        line += ` — loader targets: ${states.join(", ")}`;
        if (gone === targets.size) line += ` → every target is gone; this proposal can no longer execute and should be cancelled`;
        else if (lamports > 0n && [...targets.values()].every((op) => op === "close")) line += ` → closing returns ${(Number(lamports) / 1e9).toFixed(3)} SOL of rent to the recipient`;
      }
      parts.push(line);
    }
    anomalies.push(`${stillActive.length} proposal(s) still open: ${parts.join("; ")}. Each holds ~0.0077 SOL of proposal rent until closed.`);
  }
  if (seenOnce.length) anomalies.push(`${seenOnce.length} destination(s) appeared in exactly one proposal: ${seenOnce.map(short).join(", ")}.`);
  if (executedRefused.length) anomalies.push(`${executedRefused.length} executed proposal(s) the observed rules would still refuse (see table) — these are the shapes you must decide about before a co-signer goes live.`);

  const md = [];
  md.push(`# Treasury screen — ${multisigPda.toBase58()}`);
  md.push(``);
  md.push(`Generated ${new Date().toISOString()} by [squads-cosigner](https://github.com/Protogonos42/squads-cosigner) \`scripts/screen.js\`, read-only, from public chain state via \`${rpc}\`. Written by an AI agent (Protogonos); verify anything you act on.`);
  for (const v of resolved.via) md.push(``, `Resolved from input: ${v}`);
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
  md.push(`### Spending limits`);
  md.push(``);
  if (spendingLimits === null) {
    md.push(`Could not list SpendingLimit accounts from this RPC (getProgramAccounts refused). Config proposals below still show every AddSpendingLimit/RemoveSpendingLimit with its arguments; whether each is still live is unverified.`);
  } else if (!spendingLimits.length) {
    md.push(`None live. Nobody can move funds from any vault without ${votersNeeded} approval(s).`);
  } else {
    md.push(`A spending limit is a **threshold bypass by design**: the listed keys can move up to the amount per period to the listed destinations with no approvals at all.`);
    md.push(``);
    md.push(`| Vault | Amount / period | Remaining | Who can spend | Destinations | Member of multisig? |`);
    md.push(`|---|---|---|---|---|---|`);
    const memberSet = new Set(ms.members.map((m) => m.key));
    for (const s of spendingLimits) {
      const who = s.members.map((m) => `\`${shortKey(m)}\``).join(", ");
      const isMember = s.members.every((m) => memberSet.has(m)) ? "yes" : "**no — a non-member key can spend**";
      md.push(`| ${s.vaultIndex} | ${fmtAmount(s.mint, s.amount)} / ${s.period} | ${fmtAmount(s.mint, s.remaining)} | ${who} | ${s.destinations.length ? s.destinations.map((d) => `\`${shortKey(d)}\``).join(", ") : "any"} | ${isMember} |`);
    }
  }
  md.push(``);
  md.push(`## Proposal history`);
  md.push(``);
  md.push(`| # | Created | Type | Status | Instructions | Verdict under observed rules | Lamports out | Note |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const when = r.create?.blockTime ? new Date(r.create.blockTime * 1000).toISOString().slice(0, 10) : "?";
    const type = r.kind === "vaultCreate" ? "vault" : r.kind === "configCreate" ? "config" : r.kind;
    const ixs = r.decoded?.message ? r.decoded.message.instructions.map((ix) => (ix.explain?.op && ix.explain.op !== "unknown" ? ix.explain.op : `${ix.programName || short(ix.programId)}.unknown`)).join("<br>") : r.decoded?.configDetails ? r.decoded.configDetails.join("<br>") : r.decoded?.configActions ? r.decoded.configActions.join("<br>") : "—";
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
