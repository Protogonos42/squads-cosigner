/**
 * The rule engine. Pure and static: takes a decoded vault message (or a
 * config transaction) plus a rules document, returns a verdict with reasons.
 * No RPC, no simulation (simulation-derived caps are layered on in `check`).
 *
 * Design rule: the engine may only ever say APPROVE when every instruction
 * has been positively understood and passed every rule. Anything it cannot
 * interpret is REFUSED_UNSCREENABLE (unless the rules explicitly allow that
 * program), never silently approved.
 */
import type { DecodedVaultMessage, DecodedInstruction, DecodedConfigTransaction } from "./decode";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM } from "./programs";

export type Verdict =
  | "APPROVE"
  | "REFUSED_COUNTERPARTY"
  | "REFUSED_THEFT_SHAPED"
  | "REFUSED_CONFIG_CHANGE"
  | "REFUSED_MINT_CUSTODY"
  | "REFUSED_OVER_CAP"
  | "REFUSED_UNSCREENABLE";

/** Severity order used when several rules fire: the most structural refusal wins. */
const SEVERITY: Verdict[] = [
  "REFUSED_CONFIG_CHANGE",
  "REFUSED_THEFT_SHAPED",
  "REFUSED_MINT_CUSTODY",
  "REFUSED_COUNTERPARTY",
  "REFUSED_OVER_CAP",
  "REFUSED_UNSCREENABLE",
  "APPROVE",
];

export interface Rules {
  /** the vault PDA this rules file protects (index 0 vault of the multisig) */
  vault: string;
  /** the multisig PDA that owns `vault`; needed by `watch` to find its proposals */
  multisig?: string;
  /** programs the vault message may invoke. Unlisted programs → REFUSED_UNSCREENABLE. */
  allowPrograms: string[];
  /** programs never allowed even if listed above */
  denyPrograms?: string[];
  /** if non-empty, every lamport/token destination must be in this list (or be the vault / an ATA owned by the vault) */
  allowDestinations?: string[];
  /** destinations that are refused outright */
  denyDestinations?: string[];
  /** static per-proposal cap on lamports leaving the vault (sum over instructions), as a string to keep u64 exact */
  maxLamportsOut?: string;
  /** static per-proposal cap on token units leaving vault-owned accounts, keyed by mint ("*" = any mint) */
  maxTokenOut?: Record<string, string>;
  /** treat address-lookup-table keys as unscreenable (default true; `check` can resolve them and re-run) */
  strictLookupTables?: boolean;
  /** allow ConfigTransactions at all (default false) */
  allowConfigTransactions?: boolean;
  /** allow the vault to create token accounts / mints for itself (ATA create, initializeAccount) — default true */
  allowVaultTokenAccounts?: boolean;
  /**
   * When a simulation succeeded, do not refuse instructions to *allowed* programs merely because
   * their data could not be interpreted (DEX routers, unknown programs). The simulated diffs,
   * caps and ownership checks then govern. Default false. Unlisted programs are still refused.
   */
  trustSimulationForAllowedPrograms?: boolean;
  /** cap on lamports the simulation shows leaving beyond what the static reading of the instructions accounts for */
  maxUnexplainedLamportsOut?: string;
}

export interface Reason {
  verdict: Verdict;
  rule: string;
  instruction: number | null;
  detail: string;
}

export interface Evaluation {
  verdict: Verdict;
  reasons: Reason[];
  /** static totals the engine could see (not simulation) */
  lamportsOut: string;
  tokenOut: Record<string, string>;
}

export const DEFAULT_ALLOW_PROGRAMS = [SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM];

export function worstVerdict(reasons: Reason[]): Verdict {
  let best = SEVERITY.length - 1;
  for (const r of reasons) best = Math.min(best, SEVERITY.indexOf(r.verdict));
  return SEVERITY[best];
}
const worst = worstVerdict;

export interface EvaluateOptions {
  /** true when a successful simulation backs this evaluation (enables `trustSimulationForAllowedPrograms`) */
  simulated?: boolean;
}

function isVaultOrOwned(key: string | null, rules: Rules, vaultOwnedAccounts: Set<string>): boolean {
  return key !== null && (key === rules.vault || vaultOwnedAccounts.has(key));
}

function destinationAllowed(key: string | null, rules: Rules, vaultOwned: Set<string>): { ok: boolean; why: string } {
  if (key === null) return { ok: false, why: "destination account missing" };
  if (rules.denyDestinations?.includes(key)) return { ok: false, why: `destination ${key} is in denyDestinations` };
  if (isVaultOrOwned(key, rules, vaultOwned)) return { ok: true, why: "destination is the vault or a vault-owned account" };
  if (rules.allowDestinations && rules.allowDestinations.length > 0 && !rules.allowDestinations.includes(key)) {
    return { ok: false, why: `destination ${key} is not in allowDestinations` };
  }
  return { ok: true, why: "destination permitted" };
}

export interface ConfigContext {
  /** The multisig's current time lock in seconds, if the caller fetched it. Unknown → SetTimeLock is refused. */
  currentTimeLock?: number;
}

/** Evaluate a ConfigTransaction. Always REFUSED_CONFIG_CHANGE unless rules opt in. */
export function evaluateConfigTransaction(tx: DecodedConfigTransaction, rules: Rules, ctx: ConfigContext = {}): Evaluation {
  const reasons: Reason[] = [];
  if (!rules.allowConfigTransactions) {
    reasons.push({ verdict: "REFUSED_CONFIG_CHANGE", rule: "allowConfigTransactions=false", instruction: null, detail: `ConfigTransaction with actions [${tx.actions.map((a) => a.kind).join(", ")}]` });
  } else {
    // Even when allowed, some actions are theft-shaped by construction.
    for (const [i, a] of tx.actions.entries()) {
      if (["AddMember", "RemoveMember", "ChangeThreshold", "SetRentCollector"].includes(a.kind)) {
        // Who controls the vault.
        reasons.push({ verdict: "REFUSED_THEFT_SHAPED", rule: "config.membership", instruction: i, detail: `${a.kind} would change who controls the vault` });
      } else if (a.kind === "SetTimeLock") {
        // Shortening the time lock removes the window in which a bad proposal can be seen and rejected
        // (the Drift April 2026 chain went through "zero timelock"). Lengthening is fine; unknown current → refuse.
        const next = Number(a.args.newTimeLock);
        if (ctx.currentTimeLock === undefined) {
          reasons.push({ verdict: "REFUSED_THEFT_SHAPED", rule: "config.timelock", instruction: i, detail: `SetTimeLock(${next}) with current time lock unknown — cannot prove it does not shorten` });
        } else if (!(next >= ctx.currentTimeLock)) {
          reasons.push({ verdict: "REFUSED_THEFT_SHAPED", rule: "config.timelock", instruction: i, detail: `SetTimeLock would shorten the time lock ${ctx.currentTimeLock}s → ${next}s` });
        }
      } else if (a.kind === "AddSpendingLimit") {
        // A spending limit lets the listed members move funds with no proposal, no threshold and no co-signer.
        reasons.push({ verdict: "REFUSED_THEFT_SHAPED", rule: "config.spendingLimit", instruction: i, detail: `AddSpendingLimit would let members [${(a.args.members as string[] | undefined)?.join(", ") ?? "?"}] spend without this co-signer` });
      }
      // RemoveSpendingLimit only tightens; allowed.
    }
  }
  return { verdict: worst(reasons), reasons, lamportsOut: "0", tokenOut: {} };
}

/** Evaluate a decoded vault message statically. */
export function evaluateVaultMessage(msg: DecodedVaultMessage, rules: Rules, opts: EvaluateOptions = {}): Evaluation {
  const reasons: Reason[] = [];
  const allow = new Set(rules.allowPrograms ?? []);
  const deny = new Set(rules.denyPrograms ?? []);
  const strictLut = rules.strictLookupTables ?? true;
  const allowVaultTokenAccounts = rules.allowVaultTokenAccounts ?? true;
  const trustSim = opts.simulated === true && rules.trustSimulationForAllowedPrograms === true;

  // Accounts we learn are owned by the vault within this message (ATAs it creates for itself).
  const vaultOwned = new Set<string>();
  for (const ix of msg.instructions) {
    const e = ix.explain;
    if ((e.op.startsWith("spl-associated-token-account.create")) && e.detail.owner === rules.vault && typeof e.detail.ata === "string") vaultOwned.add(e.detail.ata);
    if (e.op.endsWith(".initializeAccount") && typeof e.detail.account === "string") {
      // owner is the 3rd account for initializeAccount(1); for initializeAccount2/3 it's in data — treat conservatively: only if owner account == vault
      const ownerMeta = ix.accounts[2];
      if (ownerMeta && ownerMeta.pubkey === rules.vault) vaultOwned.add(e.detail.account as string);
    }
  }

  let lamportsOut = 0n;
  const tokenOut: Record<string, bigint> = {};

  if (msg.unresolvedLookupKeys > 0 && strictLut) {
    reasons.push({ verdict: "REFUSED_UNSCREENABLE", rule: "strictLookupTables", instruction: null, detail: `${msg.unresolvedLookupKeys} account(s) come from address lookup tables and are not resolved` });
  }

  for (const ix of msg.instructions) {
    const e = ix.explain;
    const n = ix.index;
    const pid = ix.programId;

    // Only *unresolved* lookup keys are unscreenable; keys resolved from a table (simulate.ts) are real pubkeys.
    if (ix.accounts.some((a) => a.fromLookupTable && a.pubkey.startsWith("<lookup")) || pid.startsWith("<lookup")) {
      if (strictLut) {
        reasons.push({ verdict: "REFUSED_UNSCREENABLE", rule: "strictLookupTables", instruction: n, detail: "instruction references unresolved lookup-table accounts; cannot identify its counterparties" });
        continue;
      }
    }

    if (deny.has(pid)) {
      reasons.push({ verdict: "REFUSED_COUNTERPARTY", rule: "denyPrograms", instruction: n, detail: `program ${pid} is denied` });
      continue;
    }
    if (!allow.has(pid)) {
      reasons.push({ verdict: "REFUSED_UNSCREENABLE", rule: "allowPrograms", instruction: n, detail: `program ${pid} (${ix.programName ?? "unknown"}) is not in allowPrograms` });
      continue;
    }
    if (e.op === "unknown" || e.op === "malformed" || /\.(unknown|\d+)$/.test(e.op)) {
      if (!trustSim) {
        reasons.push({ verdict: "REFUSED_UNSCREENABLE", rule: "interpretable", instruction: n, detail: `instruction to ${ix.programName ?? pid} could not be interpreted (${e.op})` });
      }
      continue; // nothing further can be read statically; simulation diffs govern when trusted
    }

    // --- structural refusals ---
    if (e.flags.squadsConfig) {
      reasons.push({ verdict: "REFUSED_CONFIG_CHANGE", rule: "no-squads-cpi", instruction: n, detail: "vault message calls back into the Squads program" });
    }
    if (e.flags.createsMint) {
      reasons.push({ verdict: "REFUSED_MINT_CUSTODY", rule: "no-mint-creation", instruction: n, detail: `${e.op} would create a token mint` });
    }
    if (e.flags.mintsTokens) {
      reasons.push({ verdict: "REFUSED_MINT_CUSTODY", rule: "no-minting", instruction: n, detail: `${e.op} would issue tokens` });
    }
    if (e.flags.upgradesProgram) {
      reasons.push({ verdict: "REFUSED_THEFT_SHAPED", rule: "no-program-upgrade", instruction: n, detail: `${e.op}` });
    }
    if (e.flags.changesAuthority) {
      // Any authority change on the vault itself or a vault-owned account is a handoff.
      const target = (e.detail.account ?? e.detail.source ?? e.detail.stakeAccount ?? null) as string | null;
      const involvesVault = isVaultOrOwned(target, rules, vaultOwned) || ix.accounts.some((a) => a.isSigner && a.pubkey === rules.vault);
      // Setting the authority to the vault itself (e.g. initialising the vault's own nonce account) hands nothing over.
      const toVault = e.detail.newAuthority === rules.vault;
      if (involvesVault && !toVault) reasons.push({ verdict: "REFUSED_THEFT_SHAPED", rule: "no-authority-handoff", instruction: n, detail: `${e.op} on ${target ?? "vault-signed account"} would hand control to another key` });
    }
    if (e.op === "system.assign") {
      reasons.push({ verdict: "REFUSED_THEFT_SHAPED", rule: "no-assign", instruction: n, detail: "system.assign changes an account's owner program" });
    }
    if (e.flags.closesAccount) {
      const dest = (e.detail.destination ?? null) as string | null;
      const acct = (e.detail.account ?? null) as string | null;
      if (isVaultOrOwned(acct, rules, vaultOwned) || ix.accounts.some((a) => a.isSigner && a.pubkey === rules.vault)) {
        const d = destinationAllowed(dest, rules, vaultOwned);
        if (!d.ok || !isVaultOrOwned(dest, rules, vaultOwned)) {
          reasons.push({ verdict: "REFUSED_THEFT_SHAPED", rule: "close-to-foreign", instruction: n, detail: `${e.op} sends the closed account's lamports to ${dest ?? "?"} (not the vault)` });
        }
      }
    }

    // --- token custody: the vault may only move tokens it owns ---
    if (e.flags.movesTokens || e.op.endsWith(".approve") || e.op.endsWith(".approveChecked")) {
      const authority = (e.detail.authority ?? e.detail.owner ?? null) as string | null;
      if (authority !== null && authority !== rules.vault && !vaultOwned.has(authority)) {
        reasons.push({ verdict: "REFUSED_MINT_CUSTODY", rule: "own-tokens-only", instruction: n, detail: `${e.op} is authorised by ${authority}, not the vault — it would move someone else's tokens` });
      }
    }

    // --- counterparties and caps on value leaving the vault ---
    if (e.flags.movesLamports) {
      const from = (e.detail.from ?? e.detail.payer ?? e.detail.account ?? null) as string | null;
      const to = (e.detail.to ?? e.detail.destination ?? e.detail.newAccount ?? e.detail.ata ?? e.detail.stakePool ?? null) as string | null;
      const amt = typeof e.detail.lamports === "string" ? BigInt(e.detail.lamports) : 0n;
      // Lamports moved under the vault's own signature (e.g. a nonce withdrawal it authorises) are the vault's.
      if (from === rules.vault || isVaultOrOwned(from, rules, vaultOwned) || e.detail.authority === rules.vault) {
        lamportsOut += amt;
        const isSelfTokenAccount = allowVaultTokenAccounts && e.op.startsWith("spl-associated-token-account.create") && e.detail.owner === rules.vault;
        if (!isSelfTokenAccount) {
          const d = destinationAllowed(to, rules, vaultOwned);
          if (!d.ok) reasons.push({ verdict: "REFUSED_COUNTERPARTY", rule: "destinations", instruction: n, detail: `${e.op}: ${d.why}` });
        }
      }
    }
    if (e.flags.movesTokens && e.op.includes("transfer")) {
      const src = (e.detail.source ?? null) as string | null;
      const dst = (e.detail.destination ?? null) as string | null;
      const mint = (e.detail.mint ?? "*") as string;
      const amt = typeof e.detail.amount === "string" ? BigInt(e.detail.amount) : 0n;
      const authority = (e.detail.authority ?? null) as string | null;
      if (authority === rules.vault || isVaultOrOwned(src, rules, vaultOwned)) {
        tokenOut[mint] = (tokenOut[mint] ?? 0n) + amt;
        const d = destinationAllowed(dst, rules, vaultOwned);
        if (!d.ok) reasons.push({ verdict: "REFUSED_COUNTERPARTY", rule: "destinations", instruction: n, detail: `${e.op}: ${d.why}` });
      }
    }
    if (e.op === "spl-stake-pool.withdrawSol") {
      const amt = typeof e.detail.poolTokens === "string" ? BigInt(e.detail.poolTokens) : 0n;
      tokenOut["*"] = (tokenOut["*"] ?? 0n) + amt;
      const d = destinationAllowed((e.detail.to ?? null) as string | null, rules, vaultOwned);
      if (!d.ok) reasons.push({ verdict: "REFUSED_COUNTERPARTY", rule: "destinations", instruction: n, detail: `${e.op}: ${d.why}` });
    }
  }

  if (rules.maxLamportsOut !== undefined && lamportsOut > BigInt(rules.maxLamportsOut)) {
    reasons.push({ verdict: "REFUSED_OVER_CAP", rule: "maxLamportsOut", instruction: null, detail: `${lamportsOut} lamports would leave the vault; cap is ${rules.maxLamportsOut}` });
  }
  if (rules.maxTokenOut) {
    for (const [mint, amt] of Object.entries(tokenOut)) {
      const cap = rules.maxTokenOut[mint] ?? rules.maxTokenOut["*"];
      if (cap !== undefined && amt > BigInt(cap)) {
        reasons.push({ verdict: "REFUSED_OVER_CAP", rule: "maxTokenOut", instruction: null, detail: `${amt} units of ${mint} would leave the vault; cap is ${cap}` });
      }
    }
  }

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokenOut)) out[k] = v.toString();
  return { verdict: worst(reasons), reasons, lamportsOut: lamportsOut.toString(), tokenOut: out };
}

export function validateRules(r: unknown): Rules {
  if (!r || typeof r !== "object") throw new Error("rules must be an object");
  const x = r as Record<string, unknown>;
  if (typeof x.vault !== "string") throw new Error("rules.vault (the vault PDA) is required");
  if (!Array.isArray(x.allowPrograms)) throw new Error("rules.allowPrograms must be an array of program ids");
  for (const k of ["maxLamportsOut", "maxUnexplainedLamportsOut"]) if (x[k] !== undefined && !/^\d+$/.test(String(x[k]))) throw new Error(`rules.${k} must be a decimal string`);
  return x as unknown as Rules;
}
