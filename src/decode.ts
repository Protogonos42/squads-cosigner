/**
 * Byte-level decoding of Squads v4 accounts and inner vault messages.
 *
 * Everything here is pure: bytes in, plain JSON-serialisable objects out.
 * No RPC, no model, no prompt. Layouts come from @sqds/multisig
 * (solita-generated beet structs for program SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf).
 */
import { PublicKey } from "@solana/web3.js";
import * as sq from "@sqds/multisig";
import { explainInstruction, KNOWN_PROGRAMS } from "./programs";

const g = sq.generated;

export const PROGRAM_ID = sq.PROGRAM_ID;

export type AccountKind =
  | "Multisig"
  | "Proposal"
  | "VaultTransaction"
  | "ConfigTransaction"
  | "Batch"
  | "VaultBatchTransaction"
  | "SpendingLimit"
  | "ProgramConfig"
  | "TransactionBuffer"
  | "Unknown";

const DISCRIMINATORS: Array<[AccountKind, number[]]> = [
  ["Multisig", g.multisigDiscriminator],
  ["Proposal", g.proposalDiscriminator],
  ["VaultTransaction", g.vaultTransactionDiscriminator],
  ["ConfigTransaction", g.configTransactionDiscriminator],
  ["Batch", g.batchDiscriminator],
  ["VaultBatchTransaction", g.vaultBatchTransactionDiscriminator],
  ["SpendingLimit", g.spendingLimitDiscriminator],
  ["ProgramConfig", g.programConfigDiscriminator],
  ["TransactionBuffer", g.transactionBufferDiscriminator],
];

export function accountKind(data: Uint8Array): AccountKind {
  if (data.length < 8) return "Unknown";
  for (const [kind, disc] of DISCRIMINATORS) {
    if (disc.every((b, i) => data[i] === b)) return kind;
  }
  return "Unknown";
}

// ---------- Multisig ----------

export interface DecodedMember {
  key: string;
  permissions: { mask: number; initiate: boolean; vote: boolean; execute: boolean };
}

export interface DecodedMultisig {
  kind: "Multisig";
  createKey: string;
  configAuthority: string | null;
  threshold: number;
  timeLock: number;
  transactionIndex: string;
  staleTransactionIndex: string;
  rentCollector: string | null;
  bump: number;
  members: DecodedMember[];
  vault0: string;
}

function isDefaultKey(k: PublicKey): boolean {
  return k.equals(PublicKey.default);
}

export function decodeMultisig(data: Uint8Array, address?: PublicKey): DecodedMultisig {
  const [m] = sq.accounts.Multisig.fromAccountInfo({ data: Buffer.from(data) } as any);
  const members: DecodedMember[] = m.members.map((mem) => ({
    key: mem.key.toBase58(),
    permissions: {
      mask: mem.permissions.mask,
      initiate: (mem.permissions.mask & 1) !== 0,
      vote: (mem.permissions.mask & 2) !== 0,
      execute: (mem.permissions.mask & 4) !== 0,
    },
  }));
  let vault0 = "";
  if (address) {
    const [v] = sq.getVaultPda({ multisigPda: address, index: 0 });
    vault0 = v.toBase58();
  }
  return {
    kind: "Multisig",
    createKey: m.createKey.toBase58(),
    configAuthority: isDefaultKey(m.configAuthority) ? null : m.configAuthority.toBase58(),
    threshold: m.threshold,
    timeLock: m.timeLock,
    transactionIndex: sq.utils.toBigInt(m.transactionIndex).toString(),
    staleTransactionIndex: sq.utils.toBigInt(m.staleTransactionIndex).toString(),
    rentCollector: m.rentCollector ? m.rentCollector.toBase58() : null,
    bump: m.bump,
    members,
    vault0,
  };
}

// ---------- Proposal ----------

export type ProposalStatusKind = "Draft" | "Active" | "Rejected" | "Approved" | "Executing" | "Executed" | "Cancelled";

export interface DecodedProposal {
  kind: "Proposal";
  multisig: string;
  transactionIndex: string;
  status: { kind: ProposalStatusKind; timestamp: string | null };
  approved: string[];
  rejected: string[];
  cancelled: string[];
  bump: number;
}

export function decodeProposal(data: Uint8Array): DecodedProposal {
  const [p] = sq.accounts.Proposal.fromAccountInfo({ data: Buffer.from(data) } as any);
  const st = p.status as any;
  return {
    kind: "Proposal",
    multisig: p.multisig.toBase58(),
    transactionIndex: sq.utils.toBigInt(p.transactionIndex).toString(),
    status: { kind: st.__kind, timestamp: st.timestamp !== undefined ? sq.utils.toBigInt(st.timestamp).toString() : null },
    approved: p.approved.map((k) => k.toBase58()),
    rejected: p.rejected.map((k) => k.toBase58()),
    cancelled: p.cancelled.map((k) => k.toBase58()),
    bump: p.bump,
  };
}

// ---------- VaultTransactionMessage (the inner message) ----------

export interface DecodedAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
  /** true if the key came from an address lookup table rather than the static list */
  fromLookupTable: boolean;
}

export interface DecodedInstruction {
  index: number;
  programId: string;
  programName: string | null;
  accounts: DecodedAccountMeta[];
  dataHex: string;
  dataLength: number;
  /** Human/rule-readable interpretation when the program+ix is known; never authoritative on its own. */
  explain: ReturnType<typeof explainInstruction>;
}

export interface DecodedVaultMessage {
  numSigners: number;
  numWritableSigners: number;
  numWritableNonSigners: number;
  accountKeys: string[];
  addressTableLookups: Array<{ table: string; writableIndexes: number[]; readonlyIndexes: number[] }>;
  instructions: DecodedInstruction[];
  /** keys referenced through lookup tables are NOT resolved here (needs RPC); indices ≥ accountKeys.length point into them */
  unresolvedLookupKeys: number;
}

/**
 * Decode the compact wire-format `TransactionMessage` carried inside a
 * `vault_transaction_create` instruction. This is NOT the beet layout of the
 * stored VaultTransaction account (Vec with u32 lengths); it is Squads'
 * SmallVec encoding (programs/squads_multisig_program/src/utils/small_vec.rs):
 *   num_signers u8, num_writable_signers u8, num_writable_non_signers u8,
 *   account_keys: SmallVec<u8, Pubkey>,
 *   instructions: SmallVec<u8, CompiledInstruction{ program_id_index u8,
 *       account_indexes: SmallVec<u8,u8>, data: SmallVec<u16,u8> }>,
 *   address_table_lookups: SmallVec<u8, { account_key Pubkey,
 *       writable_indexes: SmallVec<u8,u8>, readonly_indexes: SmallVec<u8,u8> }>
 */
export function decodeVaultMessage(bytes: Uint8Array, tables?: LookupTables): DecodedVaultMessage {
  return decodeVaultMessageObject(parseCompactVaultMessage(bytes), tables);
}

/** Parse the compact wire TransactionMessage into the SDK's object form (no interpretation). */
export function parseCompactVaultMessage(bytes: Uint8Array): sq.generated.VaultTransactionMessage {
  const b = Buffer.from(bytes);
  let off = 0;
  const need = (n: number) => {
    if (off + n > b.length) throw new Error(`compact TransactionMessage truncated at byte ${off} (need ${n}, have ${b.length - off})`);
  };
  const u8 = () => {
    need(1);
    return b[off++];
  };
  const u16 = () => {
    need(2);
    const v = b.readUInt16LE(off);
    off += 2;
    return v;
  };
  const pubkey = () => {
    need(32);
    const k = new PublicKey(b.subarray(off, off + 32));
    off += 32;
    return k;
  };
  const u8vec = () => {
    const n = u8();
    need(n);
    const out = Array.from(b.subarray(off, off + n));
    off += n;
    return out;
  };

  const numSigners = u8();
  const numWritableSigners = u8();
  const numWritableNonSigners = u8();
  const nKeys = u8();
  const accountKeys: PublicKey[] = [];
  for (let i = 0; i < nKeys; i++) accountKeys.push(pubkey());
  const nIx = u8();
  const instructions: sq.generated.MultisigCompiledInstruction[] = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = u8();
    const accountIndexes = Uint8Array.from(u8vec());
    const dlen = u16();
    need(dlen);
    const data = Uint8Array.from(b.subarray(off, off + dlen));
    off += dlen;
    instructions.push({ programIdIndex, accountIndexes, data });
  }
  const nLut = u8();
  const addressTableLookups: sq.generated.MultisigMessageAddressTableLookup[] = [];
  for (let i = 0; i < nLut; i++) {
    const accountKey = pubkey();
    const writableIndexes = Uint8Array.from(u8vec());
    const readonlyIndexes = Uint8Array.from(u8vec());
    addressTableLookups.push({ accountKey, writableIndexes, readonlyIndexes });
  }
  if (off !== b.length) throw new Error(`compact TransactionMessage has ${b.length - off} trailing bytes`);

  return { numSigners, numWritableSigners, numWritableNonSigners, accountKeys, instructions, addressTableLookups };
}

/**
 * Address-lookup-table contents, keyed by table address: the full `addresses`
 * list of each table the message references. Supplied by RPC (see simulate.ts)
 * or by a test. When given, lookup keys are resolved to real pubkeys and
 * `unresolvedLookupKeys` is 0; `fromLookupTable` stays true so rules can still
 * tell where a key came from.
 */
export type LookupTables = Map<string, string[]>;

export function decodeVaultMessageObject(msg: sq.generated.VaultTransactionMessage, tables?: LookupTables): DecodedVaultMessage {
  const staticKeys = msg.accountKeys.map((k) => k.toBase58());
  const lookups = msg.addressTableLookups.map((l) => ({
    table: l.accountKey.toBase58(),
    writableIndexes: Array.from(l.writableIndexes),
    readonlyIndexes: Array.from(l.readonlyIndexes),
  }));
  const nLookupWritable = lookups.reduce((a, l) => a + l.writableIndexes.length, 0);
  const nLookupReadonly = lookups.reduce((a, l) => a + l.readonlyIndexes.length, 0);
  const nStatic = staticKeys.length;

  // Resolved lookup keys in message order: all writable (table order), then all readonly.
  const resolved: Array<string | null> = [];
  let unresolved = 0;
  const pushFrom = (table: string, idx: number) => {
    const addrs = tables?.get(table);
    const k = addrs ? addrs[idx] : undefined;
    if (k === undefined) unresolved++;
    resolved.push(k ?? null);
  };
  for (const l of lookups) for (const i of l.writableIndexes) pushFrom(l.table, i);
  for (const l of lookups) for (const i of l.readonlyIndexes) pushFrom(l.table, i);

  const keyAt = (i: number): DecodedAccountMeta => {
    if (i < nStatic) {
      return {
        pubkey: staticKeys[i],
        isSigner: sq.utils.isSignerIndex(msg, i),
        isWritable: sq.utils.isStaticWritableIndex(msg, i),
        fromLookupTable: false,
      };
    }
    const j = i - nStatic;
    const isWritable = j < nLookupWritable;
    return { pubkey: resolved[j] ?? `<lookup#${j}>`, isSigner: false, isWritable, fromLookupTable: true };
  };

  const instructions: DecodedInstruction[] = msg.instructions.map((ix, n) => {
    const programMeta = keyAt(ix.programIdIndex);
    const accounts = Array.from(ix.accountIndexes).map(keyAt);
    const data = Buffer.from(ix.data);
    const programId = programMeta.pubkey;
    return {
      index: n,
      programId,
      programName: KNOWN_PROGRAMS[programId] ?? null,
      accounts,
      dataHex: data.toString("hex"),
      dataLength: data.length,
      explain: explainInstruction(programId, accounts, data),
    };
  });

  return {
    numSigners: msg.numSigners,
    numWritableSigners: msg.numWritableSigners,
    numWritableNonSigners: msg.numWritableNonSigners,
    accountKeys: staticKeys,
    addressTableLookups: lookups,
    instructions,
    unresolvedLookupKeys: tables ? unresolved : nLookupWritable + nLookupReadonly,
  };
}

// ---------- VaultTransaction account ----------

export interface DecodedVaultTransaction {
  kind: "VaultTransaction";
  multisig: string;
  creator: string;
  index: string;
  bump: number;
  vaultIndex: number;
  vaultBump: number;
  ephemeralSignerBumps: number[];
  message: DecodedVaultMessage;
}

export function decodeVaultTransaction(data: Uint8Array, tables?: LookupTables): DecodedVaultTransaction {
  const [t] = sq.accounts.VaultTransaction.fromAccountInfo({ data: Buffer.from(data) } as any);
  return {
    kind: "VaultTransaction",
    multisig: t.multisig.toBase58(),
    creator: t.creator.toBase58(),
    index: sq.utils.toBigInt(t.index).toString(),
    bump: t.bump,
    vaultIndex: t.vaultIndex,
    vaultBump: t.vaultBump,
    ephemeralSignerBumps: Array.from(t.ephemeralSignerBumps),
    message: decodeVaultMessageObject(t.message, tables),
  };
}

/** Raw SDK form of a VaultTransaction account (needed by simulate.ts to rebuild the message). */
export function rawVaultTransaction(data: Uint8Array): sq.generated.VaultTransaction {
  const [t] = sq.accounts.VaultTransaction.fromAccountInfo({ data: Buffer.from(data) } as any);
  return t;
}

// ---------- ConfigTransaction account ----------

export interface DecodedConfigAction {
  kind: string;
  args: Record<string, unknown>;
}

export interface DecodedConfigTransaction {
  kind: "ConfigTransaction";
  multisig: string;
  creator: string;
  index: string;
  bump: number;
  actions: DecodedConfigAction[];
}

function plain(v: unknown): unknown {
  if (v instanceof PublicKey) return v.toBase58();
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object" && "toString" in v && (v as any).constructor?.name === "BN") return (v as any).toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) o[k] = plain(x);
    return o;
  }
  return v;
}

export function decodeConfigTransaction(data: Uint8Array): DecodedConfigTransaction {
  const [t] = sq.accounts.ConfigTransaction.fromAccountInfo({ data: Buffer.from(data) } as any);
  const actions = t.actions.map((a: any) => {
    const { __kind, ...rest } = a;
    return { kind: __kind as string, args: plain(rest) as Record<string, unknown> };
  });
  return {
    kind: "ConfigTransaction",
    multisig: t.multisig.toBase58(),
    creator: t.creator.toBase58(),
    index: sq.utils.toBigInt(t.index).toString(),
    bump: t.bump,
    actions,
  };
}

// ---------- vault_transaction_create instruction (for closed accounts / fixtures) ----------

export interface DecodedVaultTransactionCreateIx {
  vaultIndex: number;
  ephemeralSigners: number;
  memo: string | null;
  message: DecodedVaultMessage;
  innerMessageBytes: Uint8Array;
}

export function decodeVaultTransactionCreateIx(ixData: Uint8Array, tables?: LookupTables): DecodedVaultTransactionCreateIx {
  const disc = g.vaultTransactionCreateInstructionDiscriminator;
  if (!disc.every((b, i) => ixData[i] === b)) throw new Error("not a vault_transaction_create instruction");
  const [args] = g.vaultTransactionCreateStruct.deserialize(Buffer.from(ixData));
  const inner = Uint8Array.from(args.args.transactionMessage);
  return {
    vaultIndex: args.args.vaultIndex,
    ephemeralSigners: args.args.ephemeralSigners,
    memo: args.args.memo ?? null,
    message: decodeVaultMessage(inner, tables),
    innerMessageBytes: inner,
  };
}

// ---------- dispatch ----------

// ---------- TransactionBuffer (staging account for large vault transactions) ----------
//
// A TransactionBuffer is where a creator uploads a message too large for one
// transaction before turning it into a VaultTransaction. It is not a proposal
// and nothing in it can be voted on or executed; the rules never see it. It is
// decoded so `inspect` can name it instead of reporting "unknown".

export interface DecodedTransactionBuffer {
  kind: "TransactionBuffer";
  multisig: string;
  creator: string;
  bufferIndex: number;
  vaultIndex: number;
  finalBufferHash: string; // hex sha256 of the complete message
  finalBufferSize: number;
  bufferSize: number; // bytes uploaded so far
  complete: boolean; // bufferSize === finalBufferSize
  message: DecodedVaultMessage | null; // decoded only when complete and parseable; never used for verdicts
}

export function decodeTransactionBuffer(data: Uint8Array): DecodedTransactionBuffer {
  const [t] = sq.accounts.TransactionBuffer.fromAccountInfo({ data: Buffer.from(data) } as any);
  const complete = t.buffer.length === t.finalBufferSize;
  let message: DecodedVaultMessage | null = null;
  if (complete) {
    try {
      message = decodeVaultMessage(t.buffer);
    } catch {
      message = null;
    }
  }
  return {
    kind: "TransactionBuffer",
    multisig: t.multisig.toBase58(),
    creator: t.creator.toBase58(),
    bufferIndex: t.bufferIndex,
    vaultIndex: t.vaultIndex,
    finalBufferHash: Buffer.from(t.finalBufferHash).toString("hex"),
    finalBufferSize: t.finalBufferSize,
    bufferSize: t.buffer.length,
    complete,
    message,
  };
}

export type DecodedAccount = DecodedMultisig | DecodedProposal | DecodedVaultTransaction | DecodedConfigTransaction | DecodedTransactionBuffer | { kind: AccountKind };

export function decodeAccount(data: Uint8Array, address?: PublicKey): DecodedAccount {
  const kind = accountKind(data);
  switch (kind) {
    case "Multisig":
      return decodeMultisig(data, address);
    case "Proposal":
      return decodeProposal(data);
    case "VaultTransaction":
      return decodeVaultTransaction(data);
    case "ConfigTransaction":
      return decodeConfigTransaction(data);
    case "TransactionBuffer":
      return decodeTransactionBuffer(data);
    default:
      return { kind };
  }
}

// ---------- PDA helpers (re-exported for callers that want them) ----------

export function pdas(multisigPda: PublicKey, transactionIndex: bigint, vaultIndex = 0) {
  const [transactionPda] = sq.getTransactionPda({ multisigPda, index: transactionIndex });
  const [proposalPda] = sq.getProposalPda({ multisigPda, transactionIndex });
  const [vaultPda] = sq.getVaultPda({ multisigPda, index: vaultIndex });
  return { transactionPda, proposalPda, vaultPda };
}
