/**
 * Known program table and minimal instruction interpreters.
 *
 * These interpretations feed `inspect` output and (later) the rule engine.
 * They cover the instructions a treasury actually issues: System transfers
 * and account creation, SPL Token / Token-2022 transfers, mint and
 * authority changes, ATA creation, stake-pool deposits. Anything else is
 * reported as `unknown` with its raw data — the rule engine treats
 * unknown as unscreenable unless a rule explicitly allows the program.
 */
import type { DecodedAccountMeta } from "./decode";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
export const STAKE_POOL_PROGRAM = "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const BPF_UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

export const KNOWN_PROGRAMS: Record<string, string> = {
  [SYSTEM_PROGRAM]: "system",
  [TOKEN_PROGRAM]: "spl-token",
  [TOKEN_2022_PROGRAM]: "spl-token-2022",
  [ATA_PROGRAM]: "spl-associated-token-account",
  [STAKE_PROGRAM]: "stake",
  [STAKE_POOL_PROGRAM]: "spl-stake-pool",
  [COMPUTE_BUDGET_PROGRAM]: "compute-budget",
  [MEMO_PROGRAM]: "memo",
  [BPF_UPGRADEABLE_LOADER]: "bpf-upgradeable-loader",
  [SQUADS_V4]: "squads-v4",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "jito-stake-pool (mint)",
  Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb: "jito-stake-pool (pool account)",
};

export interface Explained {
  /** stable, rule-addressable name e.g. "system.transfer", "spl-token.mintTo", "unknown" */
  op: string;
  /** what leaves/enters which account, when statically knowable */
  detail: Record<string, unknown>;
  /** flags the rule engine keys on */
  flags: {
    movesLamports?: boolean;
    movesTokens?: boolean;
    changesAuthority?: boolean;
    mintsTokens?: boolean;
    createsMint?: boolean;
    closesAccount?: boolean;
    upgradesProgram?: boolean;
    squadsConfig?: boolean;
    /** Token-2022 confidential-transfer family: amounts are encrypted, unreadable statically and invisible to balance diffs */
    confidential?: boolean;
  };
}

function u64le(b: Buffer, off: number): bigint {
  return b.readBigUInt64LE(off);
}
function u32le(b: Buffer, off: number): number {
  return b.readUInt32LE(off);
}
const acc = (a: DecodedAccountMeta[], i: number) => a[i]?.pubkey ?? null;

function explainSystem(a: DecodedAccountMeta[], d: Buffer): Explained {
  if (d.length < 4) return { op: "system.unknown", detail: {}, flags: {} };
  const tag = u32le(d, 0);
  switch (tag) {
    case 0: // CreateAccount { lamports u64, space u64, owner pubkey }
      return {
        op: "system.createAccount",
        detail: { from: acc(a, 0), newAccount: acc(a, 1), lamports: u64le(d, 4).toString(), space: u64le(d, 12).toString(), owner: d.length >= 52 ? require("bs58").encode(d.subarray(20, 52)) : null },
        flags: { movesLamports: true },
      };
    case 1: // Assign { owner }
      return { op: "system.assign", detail: { account: acc(a, 0), owner: require("bs58").encode(d.subarray(4, 36)) }, flags: { changesAuthority: true } };
    case 2: // Transfer { lamports }
      return { op: "system.transfer", detail: { from: acc(a, 0), to: acc(a, 1), lamports: u64le(d, 4).toString() }, flags: { movesLamports: true } };
    case 3: // CreateAccountWithSeed
      return { op: "system.createAccountWithSeed", detail: { from: acc(a, 0), newAccount: acc(a, 1) }, flags: { movesLamports: true } };
    // Durable-nonce instructions. A nonce account whose authority is handed to another key lets that key
    // execute a pre-signed transaction later (the Drift, April 2026 chain used a nonce under the attacker's key).
    case 4: // AdvanceNonceAccount — accounts [nonce, recentBlockhashes, authority]; benign
      return { op: "system.advanceNonceAccount", detail: { account: acc(a, 0), authority: acc(a, 2) }, flags: {} };
    case 5: // WithdrawNonceAccount { lamports } — accounts [nonce, to, recentBlockhashes, rent, authority]
      return { op: "system.withdrawNonceAccount", detail: { from: acc(a, 0), to: acc(a, 1), authority: acc(a, 4), lamports: u64le(d, 4).toString() }, flags: { movesLamports: true } };
    case 6: // InitializeNonceAccount { authority } — accounts [nonce, recentBlockhashes, rent]
      return { op: "system.initializeNonceAccount", detail: { account: acc(a, 0), newAuthority: d.length >= 36 ? require("bs58").encode(d.subarray(4, 36)) : null }, flags: { changesAuthority: true } };
    case 7: // AuthorizeNonceAccount { newAuthority } — accounts [nonce, authority]
      return { op: "system.authorizeNonceAccount", detail: { account: acc(a, 0), authority: acc(a, 1), newAuthority: d.length >= 36 ? require("bs58").encode(d.subarray(4, 36)) : null }, flags: { changesAuthority: true } };
    case 12: // UpgradeNonceAccount — accounts [nonce]; benign
      return { op: "system.upgradeNonceAccount", detail: { account: acc(a, 0) }, flags: {} };
    case 8: // Allocate
      return { op: "system.allocate", detail: { account: acc(a, 0), space: u64le(d, 4).toString() }, flags: {} };
    case 11: // TransferWithSeed
      return { op: "system.transferWithSeed", detail: { from: acc(a, 0), to: acc(a, 2), lamports: u64le(d, 4).toString() }, flags: { movesLamports: true } };
    default:
      return { op: `system.${tag}`, detail: {}, flags: {} };
  }
}

function explainToken(programName: string, a: DecodedAccountMeta[], d: Buffer): Explained {
  if (d.length < 1) return { op: `${programName}.unknown`, detail: {}, flags: {} };
  const tag = d[0];
  switch (tag) {
    case 0:
      return { op: `${programName}.initializeMint`, detail: { mint: acc(a, 0) }, flags: { createsMint: true } };
    case 20:
      return { op: `${programName}.initializeMint2`, detail: { mint: acc(a, 0) }, flags: { createsMint: true } };
    case 1:
    case 16:
    case 18:
      return { op: `${programName}.initializeAccount`, detail: { account: acc(a, 0), mint: acc(a, 1) }, flags: {} };
    case 3:
      return { op: `${programName}.transfer`, detail: { source: acc(a, 0), destination: acc(a, 1), authority: acc(a, 2), amount: u64le(d, 1).toString() }, flags: { movesTokens: true } };
    case 12:
      return { op: `${programName}.transferChecked`, detail: { source: acc(a, 0), mint: acc(a, 1), destination: acc(a, 2), authority: acc(a, 3), amount: u64le(d, 1).toString(), decimals: d[9] }, flags: { movesTokens: true } };
    case 4:
      return { op: `${programName}.approve`, detail: { source: acc(a, 0), delegate: acc(a, 1), owner: acc(a, 2), amount: u64le(d, 1).toString() }, flags: { changesAuthority: true } };
    case 13:
      return { op: `${programName}.approveChecked`, detail: { source: acc(a, 0), mint: acc(a, 1), delegate: acc(a, 2), owner: acc(a, 3), amount: u64le(d, 1).toString() }, flags: { changesAuthority: true } };
    case 5:
      return { op: `${programName}.revoke`, detail: { source: acc(a, 0), owner: acc(a, 1) }, flags: {} };
    case 6:
      return { op: `${programName}.setAuthority`, detail: { account: acc(a, 0), currentAuthority: acc(a, 1), authorityType: d[1], newAuthority: d[2] === 1 && d.length >= 35 ? require("bs58").encode(d.subarray(3, 35)) : null }, flags: { changesAuthority: true } };
    case 7:
      return { op: `${programName}.mintTo`, detail: { mint: acc(a, 0), destination: acc(a, 1), authority: acc(a, 2), amount: u64le(d, 1).toString() }, flags: { mintsTokens: true } };
    case 14:
      return { op: `${programName}.mintToChecked`, detail: { mint: acc(a, 0), destination: acc(a, 1), authority: acc(a, 2), amount: u64le(d, 1).toString() }, flags: { mintsTokens: true } };
    case 8:
      return { op: `${programName}.burn`, detail: { account: acc(a, 0), mint: acc(a, 1), authority: acc(a, 2), amount: u64le(d, 1).toString() }, flags: { movesTokens: true } };
    case 15:
      return { op: `${programName}.burnChecked`, detail: { account: acc(a, 0), mint: acc(a, 1), authority: acc(a, 2), amount: u64le(d, 1).toString() }, flags: { movesTokens: true } };
    case 9:
      return { op: `${programName}.closeAccount`, detail: { account: acc(a, 0), destination: acc(a, 1), owner: acc(a, 2) }, flags: { closesAccount: true, movesLamports: true } };
    case 17:
      return { op: `${programName}.syncNative`, detail: { account: acc(a, 0) }, flags: {} };
    // --- Token-2022 extension families (spl-token-2022 TokenInstruction 26+). Only the ones that can
    // move or hide a vault's value are decoded; the rest still fall to the `interpretable` fallback. ---
    case 26: { // TransferFeeExtension { sub: u8, ... }
      const sub = d.length > 1 ? d[1] : -1;
      switch (sub) {
        case 0: return { op: `${programName}.transferFee.initializeTransferFeeConfig`, detail: { mint: acc(a, 0) }, flags: {} };
        case 1: // TransferCheckedWithFee { amount u64, decimals u8, fee u64 } — accounts: source, mint, destination, authority
          return { op: `${programName}.transferFee.transferCheckedWithFee`, detail: { source: acc(a, 0), mint: acc(a, 1), destination: acc(a, 2), authority: acc(a, 3), amount: d.length >= 10 ? u64le(d, 2).toString() : "0", decimals: d.length >= 11 ? d[10] : null, fee: d.length >= 19 ? u64le(d, 11).toString() : null }, flags: { movesTokens: true } };
        case 2: // WithdrawWithheldTokensFromMint — accounts: mint, destination, authority
          return { op: `${programName}.transferFee.withdrawWithheldTokensFromMint`, detail: { mint: acc(a, 0), destination: acc(a, 1), authority: acc(a, 2) }, flags: { movesTokens: true } };
        case 3: // WithdrawWithheldTokensFromAccounts — accounts: mint, destination, authority, sources...
          return { op: `${programName}.transferFee.withdrawWithheldTokensFromAccounts`, detail: { mint: acc(a, 0), destination: acc(a, 1), authority: acc(a, 2) }, flags: { movesTokens: true } };
        case 4: return { op: `${programName}.transferFee.harvestWithheldTokensToMint`, detail: { mint: acc(a, 0) }, flags: {} };
        case 5: return { op: `${programName}.transferFee.setTransferFee`, detail: { mint: acc(a, 0), authority: acc(a, 1) }, flags: {} };
        default: return { op: `${programName}.transferFee.unknown`, detail: {}, flags: {} };
      }
    }
    case 27: { // ConfidentialTransferExtension { sub: u8, ... } — balances are ElGamal-encrypted; nothing here is screenable
      const names: Record<number, string> = { 0: "initializeMint", 1: "updateMint", 2: "configureAccount", 3: "approveAccount", 4: "emptyAccount", 5: "deposit", 6: "withdraw", 7: "transfer", 8: "applyPendingBalance", 9: "enableConfidentialCredits", 10: "disableConfidentialCredits", 11: "enableNonConfidentialCredits", 12: "disableNonConfidentialCredits", 13: "transferWithFee", 14: "configureAccountWithRegistry" };
      const sub = d.length > 1 ? d[1] : -1;
      return { op: `${programName}.confidentialTransfer.${names[sub] ?? "other"}`, detail: { account: acc(a, 0), mint: acc(a, 1), sub }, flags: { confidential: true } };
    }
    case 37: // ConfidentialTransferFeeExtension
      return { op: `${programName}.confidentialTransferFee.other`, detail: { account: acc(a, 0), sub: d.length > 1 ? d[1] : null }, flags: { confidential: true } };
    case 42: // ConfidentialMintBurn
      return { op: `${programName}.confidentialMintBurn.other`, detail: { account: acc(a, 0), sub: d.length > 1 ? d[1] : null }, flags: { confidential: true } };
    case 38: // WithdrawExcessLamports — accounts: source, destination, authority; amount is whatever exceeds rent-exemption (not in data)
      return { op: `${programName}.withdrawExcessLamports`, detail: { account: acc(a, 0), destination: acc(a, 1), authority: acc(a, 2), lamports: null }, flags: { movesLamports: true } };
    default:
      return { op: `${programName}.${tag}`, detail: {}, flags: {} };
  }
}

function explainAta(a: DecodedAccountMeta[], d: Buffer): Explained {
  const tag = d.length === 0 ? 0 : d[0];
  const op = tag === 1 ? "createIdempotent" : tag === 2 ? "recoverNested" : "create";
  return { op: `spl-associated-token-account.${op}`, detail: { payer: acc(a, 0), ata: acc(a, 1), owner: acc(a, 2), mint: acc(a, 3) }, flags: { movesLamports: op !== "recoverNested" } };
}

function explainStakePool(a: DecodedAccountMeta[], d: Buffer): Explained {
  const tag = d.length ? d[0] : -1;
  switch (tag) {
    case 14: // DepositSol(lamports)
      return { op: "spl-stake-pool.depositSol", detail: { stakePool: acc(a, 0), from: acc(a, 3), destinationTokenAccount: acc(a, 4), managerFeeAccount: acc(a, 5), referralFeeAccount: acc(a, 6), poolMint: acc(a, 7), lamports: u64le(d, 1).toString() }, flags: { movesLamports: true } };
    case 16: // WithdrawSol(pool_tokens)
      return { op: "spl-stake-pool.withdrawSol", detail: { stakePool: acc(a, 0), userTokenAccount: acc(a, 3), to: acc(a, 4), poolTokens: u64le(d, 1).toString() }, flags: { movesTokens: true } };
    case 9:
      return { op: "spl-stake-pool.depositStake", detail: { stakePool: acc(a, 0) }, flags: { movesLamports: true } };
    case 10:
      return { op: "spl-stake-pool.withdrawStake", detail: { stakePool: acc(a, 0), poolTokens: u64le(d, 1).toString() }, flags: { movesTokens: true } };
    default:
      return { op: `spl-stake-pool.${tag}`, detail: {}, flags: {} };
  }
}

function explainStake(a: DecodedAccountMeta[], d: Buffer): Explained {
  if (d.length < 4) return { op: "stake.unknown", detail: {}, flags: {} };
  const tag = u32le(d, 0);
  const names: Record<number, string> = { 0: "initialize", 1: "authorize", 2: "delegateStake", 3: "split", 4: "withdraw", 5: "deactivate", 6: "setLockup", 7: "merge", 8: "authorizeWithSeed" };
  const op = names[tag] ?? String(tag);
  return {
    op: `stake.${op}`,
    detail: { stakeAccount: acc(a, 0), ...(tag === 4 ? { to: acc(a, 1), lamports: u64le(d, 4).toString() } : {}) },
    flags: { changesAuthority: tag === 1 || tag === 8, movesLamports: tag === 4 },
  };
}

function explainLoader(a: DecodedAccountMeta[], d: Buffer): Explained {
  if (d.length < 4) return { op: "bpf-upgradeable-loader.unknown", detail: {}, flags: {} };
  const tag = u32le(d, 0);
  const names: Record<number, string> = { 0: "initializeBuffer", 1: "write", 2: "deployWithMaxDataLen", 3: "upgrade", 4: "setAuthority", 5: "close", 6: "extendProgram", 7: "setAuthorityChecked" };
  const op = names[tag] ?? String(tag);
  // Account layouts (solana_program::bpf_loader_upgradeable):
  //   upgrade(3):        [programData, program, buffer, spill, rent, clock, authority]
  //   setAuthority(4/7): [account(buffer|programData), currentAuthority, newAuthority]
  //   close(5):          [account(buffer|programData), recipient, authority, (program)]
  //   extendProgram(6):  [programData, program, (system, payer)]
  const detail: Record<string, string | undefined> = { programData: acc(a, 0) };
  if (tag === 3) Object.assign(detail, { program: acc(a, 1), buffer: acc(a, 2), spill: acc(a, 3) });
  else if (tag === 4 || tag === 7) Object.assign(detail, { account: acc(a, 0), currentAuthority: acc(a, 1), newAuthority: acc(a, 2) });
  else if (tag === 5) Object.assign(detail, { account: acc(a, 0), recipient: acc(a, 1), authority: acc(a, 2), program: acc(a, 3) });
  else if (tag === 6) Object.assign(detail, { program: acc(a, 1) });
  return { op: `bpf-upgradeable-loader.${op}`, detail, flags: { upgradesProgram: tag === 3 || tag === 2, changesAuthority: tag === 4 || tag === 7, closesAccount: tag === 5 } };
}

function explainComputeBudget(d: Buffer): Explained {
  const tag = d.length ? d[0] : -1;
  const names: Record<number, string> = { 1: "requestHeapFrame", 2: "setComputeUnitLimit", 3: "setComputeUnitPrice", 4: "setLoadedAccountsDataSizeLimit" };
  const detail: Record<string, unknown> = {};
  if (tag === 2 && d.length >= 5) detail.units = u32le(d, 1);
  if (tag === 3 && d.length >= 9) detail.microLamports = u64le(d, 1).toString();
  return { op: `compute-budget.${names[tag] ?? tag}`, detail, flags: {} };
}

export function explainInstruction(programId: string, accounts: DecodedAccountMeta[], data: Buffer): Explained {
  try {
    switch (programId) {
      case SYSTEM_PROGRAM:
        return explainSystem(accounts, data);
      case TOKEN_PROGRAM:
        return explainToken("spl-token", accounts, data);
      case TOKEN_2022_PROGRAM:
        return explainToken("spl-token-2022", accounts, data);
      case ATA_PROGRAM:
        return explainAta(accounts, data);
      case STAKE_POOL_PROGRAM:
        return explainStakePool(accounts, data);
      case STAKE_PROGRAM:
        return explainStake(accounts, data);
      case BPF_UPGRADEABLE_LOADER:
        return explainLoader(accounts, data);
      case COMPUTE_BUDGET_PROGRAM:
        return explainComputeBudget(data);
      case MEMO_PROGRAM:
        return { op: "memo", detail: { text: data.toString("utf8") }, flags: {} };
      case SQUADS_V4:
        // A vault message that calls back into Squads is almost always a config change in disguise.
        return { op: "squads-v4.cpi", detail: {}, flags: { squadsConfig: true } };
      default:
        return { op: "unknown", detail: {}, flags: {} };
    }
  } catch (e) {
    return { op: "malformed", detail: { error: String(e) }, flags: {} };
  }
}
