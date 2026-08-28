// `watch`: the unattended co-signer. Polls the multisig's proposals, and for
// each one the key has not yet voted on, calls `cosign` — which re-runs the
// rule check with simulation immediately before signing. Approved proposals
// are executed when the key holds Execute. Every decision, signed or not, is
// appended to a hash-chained JSONL audit log that `verifyAuditLog` re-checks.
import * as crypto from "crypto";
import * as fs from "fs";
import * as sq from "@sqds/multisig";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { decodeProposal } from "./decode";
import type { Rules } from "./rules";
import { cosign, SignResult } from "./sign";

export interface WatchOptions {
  rpcUrl?: string;
  connection?: Connection;
  /** multisig PDA; defaults to rules.multisig */
  multisig?: string;
  /** poll interval (default 15000 ms) */
  intervalMs?: number;
  /** stop after N rounds (default: run forever) */
  rounds?: number;
  /** also sign rejections for refused proposals (default false: refused proposals are logged and left alone) */
  rejectRefused?: boolean;
  logFile?: string;
  onEvent?: (e: AuditEntry | { event: string; [k: string]: unknown }) => void;
}

export interface AuditEntry {
  ts: string;
  seq: number;
  action: "approve" | "reject" | "execute" | "skip";
  proposal: string;
  transactionIndex: string;
  proposalStatus: string | null;
  verdict: string;
  reasons: unknown;
  permitted: boolean;
  signed: boolean;
  signature: string | null;
  error: string | null;
  prevHash: string;
  hash: string;
}

const STATUS = { Active: 1, Approved: 3 } as const;

function hashEntry(e: Omit<AuditEntry, "hash">): string {
  return crypto.createHash("sha256").update(JSON.stringify(e)).digest("hex");
}

function lastHash(file: string | undefined): { prevHash: string; seq: number } {
  if (!file || !fs.existsSync(file)) return { prevHash: "0".repeat(64), seq: 0 };
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  if (lines.length === 0) return { prevHash: "0".repeat(64), seq: 0 };
  const last = JSON.parse(lines[lines.length - 1]) as AuditEntry;
  return { prevHash: last.hash, seq: last.seq + 1 };
}

/** Re-hash an audit log; every entry must chain to the previous one. */
export function verifyAuditLog(file: string): { ok: boolean; entries: number; brokenAt: number | null } {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  let prev = "0".repeat(64);
  for (let i = 0; i < lines.length; i++) {
    const e = JSON.parse(lines[i]) as AuditEntry;
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || hashEntry(rest) !== hash || e.seq !== i) return { ok: false, entries: lines.length, brokenAt: i };
    prev = hash;
  }
  return { ok: true, entries: lines.length, brokenAt: null };
}

async function listProposals(conn: Connection, multisig: PublicKey, statusKind: number) {
  const r = await conn.getProgramAccounts(sq.PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(sq.generated.proposalDiscriminator)) } },
      { memcmp: { offset: 8, bytes: multisig.toBase58() } },
      { memcmp: { offset: 48, bytes: bs58.encode(Buffer.from([statusKind])) } },
    ],
  });
  return r.map(({ pubkey, account }) => ({ pubkey, proposal: decodeProposal(account.data) }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function watch(rules: Rules, key: Keypair, opts: WatchOptions = {}) {
  const conn = opts.connection ?? new Connection(opts.rpcUrl ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const msAddr = opts.multisig ?? rules.multisig;
  if (!msAddr) throw new Error("watch needs the multisig PDA: rules.multisig or --multisig");
  const multisig = new PublicKey(msAddr);
  const me = key.publicKey.toBase58();
  const interval = opts.intervalMs ?? 15000;
  const emit = opts.onEvent ?? (() => {});
  let { prevHash, seq } = lastHash(opts.logFile);
  const counts = { rounds: 0, approved: 0, executed: 0, rejected: 0, refused: 0, errors: 0 };

  const record = (action: AuditEntry["action"], proposal: string, r: Partial<SignResult> & { verdict: string; transactionIndex?: string; proposalStatus?: string | null }) => {
    const body: Omit<AuditEntry, "hash"> = {
      ts: new Date().toISOString(),
      seq: seq++,
      action,
      proposal,
      transactionIndex: r.transactionIndex ?? "",
      proposalStatus: r.proposalStatus ?? null,
      verdict: r.verdict,
      reasons: (r.check as { reasons?: unknown } | undefined)?.reasons ?? null,
      permitted: !!r.permitted,
      signed: !!r.signed,
      signature: r.signature ?? null,
      error: r.error ?? null,
      prevHash,
    };
    const entry: AuditEntry = { ...body, hash: hashEntry(body) };
    prevHash = entry.hash;
    if (opts.logFile) fs.appendFileSync(opts.logFile, JSON.stringify(entry) + "\n");
    emit(entry);
    return entry;
  };

  emit({ event: "start", multisig: msAddr, member: me, vault: rules.vault, interval });
  // Never act twice on the same proposal in one process unless its status changed.
  const seen = new Map<string, string>();
  for (;;) {
    counts.rounds++;
    try {
      // 1. Active proposals I have not voted on → approve (or reject if refused and allowed)
      for (const { pubkey, proposal } of await listProposals(conn, multisig, STATUS.Active)) {
        const addr = pubkey.toBase58();
        if (proposal.approved.includes(me) || proposal.rejected.includes(me)) continue;
        if (seen.get(addr) === "Active") continue;
        seen.set(addr, "Active");
        const r = await cosign("approve", addr, rules, key, { connection: conn });
        if (r.permitted) {
          record("approve", addr, r);
          if (r.error) counts.errors++;
          else counts.approved++;
        } else {
          counts.refused++;
          if (opts.rejectRefused && r.verdict !== "REFUSED_UNSCREENABLE") {
            const rj = await cosign("reject", addr, rules, key, { connection: conn });
            record("reject", addr, rj);
            if (rj.signed && !rj.error) counts.rejected++;
          } else record("skip", addr, r);
        }
        await sleep(500);
      }
      // 2. Approved proposals → execute (the gate re-checks; the program requires Execute permission)
      for (const { pubkey } of await listProposals(conn, multisig, STATUS.Approved)) {
        const addr = pubkey.toBase58();
        if (seen.get(addr) === "Approved") continue;
        seen.set(addr, "Approved");
        const r = await cosign("execute", addr, rules, key, { connection: conn });
        record("execute", addr, r);
        if (r.signed && !r.error) counts.executed++;
        else if (r.error) counts.errors++;
        await sleep(500);
      }
    } catch (e) {
      counts.errors++;
      emit({ event: "error", round: counts.rounds, error: (e as Error).message });
    }
    if (opts.rounds !== undefined && counts.rounds >= opts.rounds) break;
    await sleep(interval);
  }
  emit({ event: "stop", ...counts });
  return counts;
}
