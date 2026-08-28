/**
 * Simulation-backed screening. Resolves address lookup tables, rebuilds the
 * proposal's inner vault message as a standalone v0 transaction, simulates it
 * with `sigVerify:false` (so the vault PDA and any ephemeral signers count as
 * signers — exactly what `vault_transaction_execute` grants them), and reads
 * the pre/post state of every writable account to compute what would actually
 * leave the vault.
 *
 * Why not simulate the real `vault_transaction_execute` instruction? Because
 * the program requires `Proposal.status == Approved`, and a co-signer must
 * screen *before* approving; public RPC has no account-state overrides. The
 * standalone simulation differs from real execution in two known ways, both
 * documented in the README: the inner instructions run one CPI level shallower,
 * and the fee is paid by `feePayer` (default: the vault) rather than the
 * executor. Neither changes what value moves out of the vault.
 */
import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import * as sq from "@sqds/multisig";
import {
  DecodedVaultMessage,
  LookupTables,
  DecodedConfigTransaction,
  accountKind,
  decodeConfigTransaction,
  decodeProposal,
  decodeVaultMessageObject,
  parseCompactVaultMessage,
  pdas,
  rawVaultTransaction,
} from "./decode";
import { TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./programs";
import { Evaluation, Reason, Rules, evaluateConfigTransaction, evaluateVaultMessage, worstVerdict } from "./rules";

export interface TokenState {
  mint: string;
  owner: string;
  amount: string;
}

export interface AccountSnapshot {
  pubkey: string;
  writable: boolean;
  preLamports: string | null;
  postLamports: string | null;
  preOwner: string | null;
  postOwner: string | null;
  preToken: TokenState | null;
  postToken: TokenState | null;
}

export interface OwnershipChange {
  account: string;
  what: "token-authority" | "program-owner" | "closed";
  from: string;
  to: string | null;
}

export interface SimulationResult {
  ok: boolean;
  error: string | null;
  logs: string[];
  unitsConsumed: number | null;
  feePayer: string;
  /** exact fee the simulated transaction would pay (getFeeForMessage), or null if unavailable */
  feeLamports: string | null;
  /** lamports leaving the vault PDA, net of the fee if the vault paid it (negative = vault gained) */
  vaultLamportsOut: string;
  /** net token units leaving vault-owned token accounts, by mint (negative = gained) */
  tokenOut: Record<string, string>;
  ownershipChanges: OwnershipChange[];
  accounts: AccountSnapshot[];
  /** the message with lookup-table keys resolved */
  message: DecodedVaultMessage;
  lookupTables: Record<string, number>;
}

export interface SimulateOptions {
  rpcUrl?: string;
  connection?: Connection;
  /** fee payer for the standalone simulation; defaults to the vault */
  feePayer?: string;
}

function parseToken(owner: PublicKey, data: Uint8Array): TokenState | null {
  const o = owner.toBase58();
  if ((o !== TOKEN_PROGRAM && o !== TOKEN_2022_PROGRAM) || data.length < 165) return null;
  const b = Buffer.from(data);
  return {
    mint: new PublicKey(b.subarray(0, 32)).toBase58(),
    owner: new PublicKey(b.subarray(32, 64)).toBase58(),
    amount: b.readBigUInt64LE(64).toString(),
  };
}

/** Fetch every lookup table a raw message references. Missing tables are omitted (→ unresolved keys). */
export async function fetchLookupTables(conn: Connection, msg: sq.generated.VaultTransactionMessage): Promise<{ tables: LookupTables; accounts: AddressLookupTableAccount[] }> {
  const tables: LookupTables = new Map();
  const accounts: AddressLookupTableAccount[] = [];
  for (const l of msg.addressTableLookups) {
    const { value } = await conn.getAddressLookupTable(l.accountKey);
    if (!value) continue;
    tables.set(l.accountKey.toBase58(), value.state.addresses.map((k) => k.toBase58()));
    accounts.push(value);
  }
  return { tables, accounts };
}

/** Rebuild the inner message as web3 TransactionInstructions with fully resolved keys. Throws if a key is unresolved. */
export function instructionsFromResolved(resolved: DecodedVaultMessage): TransactionInstruction[] {
  return resolved.instructions.map((ix) => {
    if (ix.programId.startsWith("<lookup")) throw new Error(`instruction ${ix.index}: program id is an unresolved lookup key`);
    for (const a of ix.accounts) if (a.pubkey.startsWith("<lookup")) throw new Error(`instruction ${ix.index}: unresolved lookup key`);
    return new TransactionInstruction({
      programId: new PublicKey(ix.programId),
      keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
      data: Buffer.from(ix.dataHex, "hex"),
    });
  });
}

/** Simulate a raw vault message against the chain and diff the vault's holdings. Never throws on simulation failure: `ok=false`. */
export async function simulateVaultMessage(raw: sq.generated.VaultTransactionMessage, vault: string, opts: SimulateOptions = {}): Promise<SimulationResult> {
  const conn = opts.connection ?? new Connection(opts.rpcUrl ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const { tables, accounts: lutAccounts } = await fetchLookupTables(conn, raw);
  const message = decodeVaultMessageObject(raw, tables);
  const lookupTables: Record<string, number> = {};
  for (const [k, v] of tables) lookupTables[k] = v.length;
  const feePayer = opts.feePayer ?? vault;
  const base = { feePayer, message, lookupTables, unitsConsumed: null as number | null, feeLamports: null as string | null, logs: [] as string[] };
  const fail = (error: string): SimulationResult => ({ ...base, ok: false, error, vaultLamportsOut: "0", tokenOut: {}, ownershipChanges: [], accounts: [] });

  if (message.unresolvedLookupKeys > 0) return fail(`${message.unresolvedLookupKeys} lookup-table key(s) could not be resolved`);

  let ixs: TransactionInstruction[];
  try {
    ixs = instructionsFromResolved(message);
  } catch (e) {
    return fail((e as Error).message);
  }

  // Every distinct key in the message, and whether it is writable anywhere.
  const writable = new Map<string, boolean>();
  for (const ix of message.instructions) {
    for (const a of ix.accounts) writable.set(a.pubkey, (writable.get(a.pubkey) ?? false) || a.isWritable);
    if (!writable.has(ix.programId)) writable.set(ix.programId, false);
  }
  writable.set(vault, true);
  writable.set(feePayer, true);
  const watch = [...writable.entries()].filter(([, w]) => w).map(([k]) => k);

  let blockhash: string;
  try {
    blockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  } catch (e) {
    return fail(`rpc: ${(e as Error).message}`);
  }
  const compiled = new TransactionMessage({ payerKey: new PublicKey(feePayer), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(lutAccounts);
  const tx = new VersionedTransaction(compiled); // signatures zero-filled; sigVerify:false below

  const feeResp = await conn.getFeeForMessage(compiled, "confirmed").catch(() => null);
  const feeLamports = feeResp && feeResp.value !== null ? BigInt(feeResp.value) : null;

  const preInfos = await conn.getMultipleAccountsInfo(watch.map((k) => new PublicKey(k)), "confirmed");
  let sim;
  try {
    sim = await conn.simulateTransaction(tx, {
      sigVerify: false,
      commitment: "confirmed",
      accounts: { encoding: "base64", addresses: watch },
    });
  } catch (e) {
    return fail(`simulateTransaction: ${(e as Error).message}`);
  }
  const logs = sim.value.logs ?? [];
  const unitsConsumed = sim.value.unitsConsumed ?? null;
  if (sim.value.err) {
    return { ...fail(`simulation failed: ${JSON.stringify(sim.value.err)}`), logs, unitsConsumed, feeLamports: feeLamports?.toString() ?? null };
  }

  const snapshots: AccountSnapshot[] = [];
  const ownershipChanges: OwnershipChange[] = [];
  let vaultLamportsOut = 0n;
  const tokenOut: Record<string, bigint> = {};
  const post = sim.value.accounts ?? [];
  for (let i = 0; i < watch.length; i++) {
    const key = watch[i];
    const pre = preInfos[i];
    const p = post[i];
    const preToken = pre ? parseToken(pre.owner, pre.data) : null;
    const postData = p ? Buffer.from(p.data[0], "base64") : null;
    const postOwner = p ? new PublicKey(p.owner) : null;
    const postToken = p && postData && postOwner ? parseToken(postOwner, postData) : null;
    const snap: AccountSnapshot = {
      pubkey: key,
      writable: true,
      preLamports: pre ? String(pre.lamports) : null,
      postLamports: p ? String(p.lamports) : null,
      preOwner: pre ? pre.owner.toBase58() : null,
      postOwner: postOwner ? postOwner.toBase58() : null,
      preToken,
      postToken,
    };
    snapshots.push(snap);

    if (key === vault) {
      const preL = BigInt(pre?.lamports ?? 0);
      const postL = BigInt(p?.lamports ?? 0);
      vaultLamportsOut = preL - postL - (feePayer === vault && feeLamports !== null ? feeLamports : 0n);
      if (pre && postOwner && !pre.owner.equals(postOwner)) ownershipChanges.push({ account: key, what: "program-owner", from: pre.owner.toBase58(), to: postOwner.toBase58() });
    }
    if (preToken && preToken.owner === vault) {
      const postAmt = postToken ? BigInt(postToken.amount) : 0n;
      tokenOut[preToken.mint] = (tokenOut[preToken.mint] ?? 0n) + BigInt(preToken.amount) - postAmt;
      if (!p) ownershipChanges.push({ account: key, what: "closed", from: vault, to: null });
      else if (!postToken) ownershipChanges.push({ account: key, what: "program-owner", from: pre!.owner.toBase58(), to: postOwner!.toBase58() });
      else if (postToken.owner !== vault) ownershipChanges.push({ account: key, what: "token-authority", from: vault, to: postToken.owner });
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokenOut)) out[k] = v.toString();
  return { ...base, ok: true, error: null, logs, unitsConsumed, feeLamports: feeLamports?.toString() ?? null, vaultLamportsOut: vaultLamportsOut.toString(), tokenOut: out, ownershipChanges, accounts: snapshots };
}

/**
 * Pure: merge a static evaluation with a simulation result under the rules.
 * Simulation failure → REFUSED_UNSCREENABLE. Simulated outflows are checked
 * against the same caps as the static ones; a vault-owned account changing
 * hands in simulation is REFUSED_THEFT_SHAPED regardless of what the static
 * pass thought.
 */
export function applySimulation(staticEval: Evaluation, sim: Pick<SimulationResult, "ok" | "error" | "logs" | "vaultLamportsOut" | "tokenOut" | "ownershipChanges">, rules: Rules): Evaluation & { simulated: true; simulatedLamportsOut: string; simulatedTokenOut: Record<string, string> } {
  const reasons: Reason[] = [...staticEval.reasons];
  if (!sim.ok) {
    const tail = sim.logs.slice(-3).join(" | ");
    reasons.push({ verdict: "REFUSED_UNSCREENABLE", rule: "simulation", instruction: null, detail: `${sim.error ?? "simulation failed"}${tail ? ` — ${tail}` : ""}` });
  } else {
    for (const c of sim.ownershipChanges) {
      reasons.push({ verdict: "REFUSED_THEFT_SHAPED", rule: "simulated-ownership-change", instruction: null, detail: `${c.account} (${c.what}) would pass from ${c.from} to ${c.to ?? "nobody"}` });
    }
    const lamOut = BigInt(sim.vaultLamportsOut);
    if (rules.maxLamportsOut !== undefined && lamOut > BigInt(rules.maxLamportsOut)) {
      reasons.push({ verdict: "REFUSED_OVER_CAP", rule: "maxLamportsOut(simulated)", instruction: null, detail: `simulation shows ${lamOut} lamports leaving the vault; cap is ${rules.maxLamportsOut}` });
    }
    if (rules.maxTokenOut) {
      for (const [mint, amtS] of Object.entries(sim.tokenOut)) {
        const amt = BigInt(amtS);
        const cap = rules.maxTokenOut[mint] ?? rules.maxTokenOut["*"];
        if (cap !== undefined && amt > BigInt(cap)) {
          reasons.push({ verdict: "REFUSED_OVER_CAP", rule: "maxTokenOut(simulated)", instruction: null, detail: `simulation shows ${amt} units of ${mint} leaving vault-owned accounts; cap is ${cap}` });
        }
      }
    }
    if (rules.maxUnexplainedLamportsOut !== undefined) {
      const unexplained = lamOut - BigInt(staticEval.lamportsOut);
      if (unexplained > BigInt(rules.maxUnexplainedLamportsOut)) {
        reasons.push({ verdict: "REFUSED_OVER_CAP", rule: "maxUnexplainedLamportsOut", instruction: null, detail: `simulation shows ${unexplained} more lamports leaving than the static reading of the instructions (${staticEval.lamportsOut}); cap is ${rules.maxUnexplainedLamportsOut}` });
      }
    }
  }
  return { ...staticEval, verdict: worstVerdict(reasons), reasons, simulated: true, simulatedLamportsOut: sim.vaultLamportsOut, simulatedTokenOut: sim.tokenOut };
}

/** Locate the raw VaultTransaction for a proposal / transaction address. */
export type FetchedTransaction =
  | { raw: sq.generated.VaultTransaction; transactionPda: string; proposal: ReturnType<typeof decodeProposal> | null }
  | { config: DecodedConfigTransaction; transactionPda: string; proposal: ReturnType<typeof decodeProposal> | null }
  | { error: string };

/** Fetch a VaultTransaction or ConfigTransaction by its own PDA or by its Proposal PDA. */
export async function fetchRawVaultTransaction(conn: Connection, addr: string): Promise<FetchedTransaction> {
  const pk = new PublicKey(addr);
  const info = await conn.getAccountInfo(pk, "confirmed");
  if (!info) return { error: "account not found (closed or never existed)" };
  if (!info.owner.equals(sq.PROGRAM_ID)) return { error: `not a Squads v4 account (owner ${info.owner.toBase58()})` };
  const kind = accountKind(info.data);
  if (kind === "VaultTransaction") return { raw: rawVaultTransaction(info.data), transactionPda: addr, proposal: null };
  if (kind === "ConfigTransaction") return { config: decodeConfigTransaction(info.data), transactionPda: addr, proposal: null };
  if (kind === "Proposal") {
    const p = decodeProposal(info.data);
    const { transactionPda } = pdas(new PublicKey(p.multisig), BigInt(p.transactionIndex));
    const t = await conn.getAccountInfo(transactionPda, "confirmed");
    if (!t) return { error: `transaction account ${transactionPda.toBase58()} not found` };
    if (accountKind(t.data) === "ConfigTransaction") return { config: decodeConfigTransaction(t.data), transactionPda: transactionPda.toBase58(), proposal: p };
    if (accountKind(t.data) !== "VaultTransaction") return { error: `transaction account is a ${accountKind(t.data)}, not a VaultTransaction` };
    return { raw: rawVaultTransaction(t.data), transactionPda: transactionPda.toBase58(), proposal: p };
  }
  return { error: `unsupported account kind ${kind}` };
}

/** End-to-end: fetch, resolve, evaluate statically on resolved keys, simulate, merge. */
export async function checkWithSimulation(addrOrFixtureIx: string | Uint8Array, rules: Rules, opts: SimulateOptions = {}) {
  const conn = opts.connection ?? new Connection(opts.rpcUrl ?? "https://api.mainnet-beta.solana.com", "confirmed");
  let raw: sq.generated.VaultTransactionMessage;
  let meta: Record<string, unknown> = {};
  if (typeof addrOrFixtureIx === "string") {
    const r = await fetchRawVaultTransaction(conn, addrOrFixtureIx);
    if ("error" in r) {
      return { address: addrOrFixtureIx, verdict: "REFUSED_UNSCREENABLE" as const, reasons: [{ verdict: "REFUSED_UNSCREENABLE" as const, rule: "fetch", instruction: null, detail: r.error }], lamportsOut: "0", tokenOut: {}, simulated: false as const };
    }
    if ("config" in r) {
      // ConfigTransactions have no inner message to simulate; the static rule decides (REFUSED_CONFIG_CHANGE unless opted in).
      const ev = evaluateConfigTransaction(r.config, rules);
      return { address: addrOrFixtureIx, transactionPda: r.transactionPda, proposal: r.proposal, kind: "ConfigTransaction" as const, creator: r.config.creator, ...ev, simulated: false as const };
    }
    raw = r.raw.message;
    meta = { address: addrOrFixtureIx, transactionPda: r.transactionPda, proposal: r.proposal, vaultIndex: r.raw.vaultIndex, creator: r.raw.creator.toBase58() };
    // Default fee payer: the proposal's creator — a member who would really pay on execution.
    // Vaults often hold no native SOL, and a payer with no lamports makes the RPC answer AccountNotFound.
    if (opts.feePayer === undefined) opts = { ...opts, feePayer: r.raw.creator.toBase58() };
  } else {
    raw = parseCompactVaultMessage(addrOrFixtureIx);
  }
  const sim = await simulateVaultMessage(raw, rules.vault, { ...opts, connection: conn });
  const staticEval = evaluateVaultMessage(sim.message, rules, { simulated: sim.ok });
  const merged = applySimulation(staticEval, sim, rules);
  const { message: _m, accounts, logs, ...simSummary } = sim;
  return { ...meta, ...merged, simulation: { ...simSummary, accounts: accounts.filter((a) => a.preLamports !== a.postLamports || a.preToken?.amount !== a.postToken?.amount || a.preOwner !== a.postOwner), logs: sim.ok ? logs.slice(-5) : logs } };
}
