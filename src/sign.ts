// Signing: the co-signer's approve / reject / execute, gated on the rule engine.
//
// The invariant this module exists to keep: NO path signs an approval or an
// execution without re-running `checkWithSimulation` itself, in-process, and
// seeing APPROVE. There is no flag, environment variable, or argument that
// substitutes a caller's claim for that check. `reject` is the mirror image:
// it signs only when the check did NOT say APPROVE.
//
// Builders (`buildApproveTx` etc.) are pure functions of chain state and are
// exported so the exact transaction the tool would sign can be inspected and
// unit-tested offline, before any key ever touches it.
import * as fs from "fs";
import * as sq from "@sqds/multisig";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { Rules } from "./rules";
import { checkWithSimulation, fetchRawVaultTransaction } from "./simulate";
import { decodeProposal, pdas } from "./decode";

export type SignAction = "approve" | "reject" | "execute";

export interface SignOptions {
  rpcUrl?: string;
  connection?: Connection;
  /** run the check and build+sign the outer transaction, simulate it, but do not send */
  dryRun?: boolean;
  memo?: string;
  /** fee payer for the proposal's inner simulation (defaults to the proposal creator) */
  simulationPayer?: string;
}

export interface SignResult {
  action: SignAction;
  address: string;
  multisig: string;
  transactionIndex: string;
  proposalStatus: string | null;
  verdict: string;
  /** the rule evaluation that gated this signature */
  check: Record<string, unknown>;
  /** did the gate permit the action? (APPROVE for approve/execute; not APPROVE for reject) */
  permitted: boolean;
  signed: boolean;
  sent: boolean;
  signature?: string;
  dryRunLogs?: string[];
  error?: string;
}

export function loadKeypair(file: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw) || raw.length !== 64) throw new Error(`${file}: expected a 64-byte JSON secret key array`);
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Locate a proposal by proposal PDA or transaction PDA → (multisig, index, status). */
export async function locateProposal(conn: Connection, addr: string): Promise<{ multisig: PublicKey; transactionIndex: bigint; status: string | null; proposalPda: PublicKey } | { error: string }> {
  const r = await fetchRawVaultTransaction(conn, addr);
  if ("error" in r) return r;
  const multisig = "raw" in r ? r.raw.multisig : new PublicKey(r.config.multisig);
  const transactionIndex = "raw" in r ? sq.utils.toBigInt(r.raw.index) : BigInt(r.config.index);
  const { proposalPda } = pdas(multisig, transactionIndex);
  let status: string | null = r.proposal?.status.kind ?? null;
  if (status === null) {
    const info = await conn.getAccountInfo(proposalPda, "confirmed");
    if (info) status = decodeProposal(info.data).status.kind;
  }
  return { multisig, transactionIndex, status, proposalPda };
}

async function outerTx(conn: Connection, payer: PublicKey, ixs: import("@solana/web3.js").TransactionInstruction[], luts: import("@solana/web3.js").AddressLookupTableAccount[] = []): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(luts);
  return new VersionedTransaction(msg);
}

export async function buildApproveTx(conn: Connection, multisigPda: PublicKey, transactionIndex: bigint, member: PublicKey, memo?: string): Promise<VersionedTransaction> {
  return outerTx(conn, member, [sq.instructions.proposalApprove({ multisigPda, transactionIndex, member, memo })]);
}

export async function buildRejectTx(conn: Connection, multisigPda: PublicKey, transactionIndex: bigint, member: PublicKey, memo?: string): Promise<VersionedTransaction> {
  return outerTx(conn, member, [sq.instructions.proposalReject({ multisigPda, transactionIndex, member, memo })]);
}

export async function buildExecuteTx(conn: Connection, multisigPda: PublicKey, transactionIndex: bigint, member: PublicKey): Promise<VersionedTransaction> {
  const { instruction, lookupTableAccounts } = await sq.instructions.vaultTransactionExecute({ connection: conn, multisigPda, transactionIndex, member });
  return outerTx(conn, member, [instruction], lookupTableAccounts);
}

/** Pure gate: what does a verdict permit? Exported so the policy is testable in isolation. */
export function permits(action: SignAction, verdict: string, proposalStatus: string | null): { ok: boolean; why: string } {
  if (action === "reject") {
    if (verdict === "APPROVE") return { ok: false, why: "rules say APPROVE; a rule-bound co-signer does not reject what its rules accept" };
    if (proposalStatus !== null && proposalStatus !== "Active") return { ok: false, why: `proposal is ${proposalStatus}, only Active proposals can be rejected` };
    return { ok: true, why: `verdict ${verdict}` };
  }
  if (verdict !== "APPROVE") return { ok: false, why: `verdict ${verdict}` };
  if (action === "approve") {
    if (proposalStatus !== null && proposalStatus !== "Active") return { ok: false, why: `proposal is ${proposalStatus}, only Active proposals can be approved` };
    return { ok: true, why: "APPROVE" };
  }
  // execute
  if (proposalStatus !== "Approved" && proposalStatus !== "ExecuteReady") return { ok: false, why: `proposal is ${proposalStatus ?? "unknown"}, must be Approved to execute` };
  return { ok: true, why: "APPROVE and proposal Approved" };
}

/**
 * The co-signer's act. Re-runs the rule check with simulation itself, decides via
 * `permits`, and only then signs with `key`. Never trusts a caller's verdict.
 */
export async function cosign(action: SignAction, addr: string, rules: Rules, key: Keypair, opts: SignOptions = {}): Promise<SignResult> {
  const conn = opts.connection ?? new Connection(opts.rpcUrl ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const loc = await locateProposal(conn, addr);
  const base = { action, address: addr, signed: false, sent: false };
  if ("error" in loc) {
    return { ...base, multisig: "", transactionIndex: "", proposalStatus: null, verdict: "REFUSED_UNSCREENABLE", check: { error: loc.error }, permitted: false, error: loc.error };
  }
  // The check, done here, by this process, on chain state as of now.
  const check = await checkWithSimulation(addr, rules, { connection: conn, feePayer: opts.simulationPayer });
  const verdict = check.verdict;
  const gate = permits(action, verdict, loc.status);
  const head: Omit<SignResult, "permitted" | "signed" | "sent"> = { action, address: addr, multisig: loc.multisig.toBase58(), transactionIndex: loc.transactionIndex.toString(), proposalStatus: loc.status, verdict, check: check as unknown as Record<string, unknown> };
  if (!gate.ok) return { ...head, permitted: false, signed: false, sent: false, error: `not ${action === "reject" ? "rejecting" : action === "approve" ? "approving" : "executing"}: ${gate.why}` };

  const tx =
    action === "approve" ? await buildApproveTx(conn, loc.multisig, loc.transactionIndex, key.publicKey, opts.memo)
    : action === "reject" ? await buildRejectTx(conn, loc.multisig, loc.transactionIndex, key.publicKey, opts.memo)
    : await buildExecuteTx(conn, loc.multisig, loc.transactionIndex, key.publicKey);
  tx.sign([key]);
  if (opts.dryRun) {
    const sim = await conn.simulateTransaction(tx, { commitment: "confirmed" });
    return { ...head, permitted: true, signed: true, sent: false, dryRunLogs: sim.value.logs ?? [], error: sim.value.err ? `dry-run simulation failed: ${JSON.stringify(sim.value.err)}` : undefined };
  }
  const signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  return { ...head, permitted: true, signed: true, sent: true, signature, error: conf.value.err ? `transaction failed: ${JSON.stringify(conf.value.err)}` : undefined };
}
