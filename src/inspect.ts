/**
 * `inspect`: read-only decode + explain of a Squads v4 multisig, proposal,
 * vault transaction, or a saved fixture. The only module in this package
 * that touches RPC for reads.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import * as sq from "@sqds/multisig";
import { accountKind, decodeAccount, decodeMultisig, decodeProposal, decodeVaultTransaction, decodeConfigTransaction, decodeVaultTransactionCreateIx, pdas, DecodedMultisig, DecodedProposal } from "./decode";

export interface InspectOptions {
  rpcUrl?: string;
  /** for a multisig: how many recent transaction indexes to enumerate */
  recent?: number;
}

export interface ProposalSummary {
  transactionIndex: string;
  proposalPda: string;
  transactionPda: string;
  proposal: DecodedProposal | null; // null → account closed/absent
  transaction: ReturnType<typeof decodeAccount> | null;
  stale: boolean;
}

export interface MultisigReport {
  address: string;
  multisig: DecodedMultisig;
  vault0Lamports: number;
  proposals: ProposalSummary[];
}

export async function inspectAddress(addr: string, opts: InspectOptions = {}): Promise<unknown> {
  const conn = new Connection(opts.rpcUrl ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const pk = new PublicKey(addr);
  const info = await conn.getAccountInfo(pk);
  if (!info) return { address: addr, error: "account not found (closed or never existed)" };
  if (!info.owner.equals(sq.PROGRAM_ID)) return { address: addr, error: `not a Squads v4 account (owner ${info.owner.toBase58()})` };
  const kind = accountKind(info.data);
  switch (kind) {
    case "Multisig":
      return inspectMultisig(conn, pk, info.data, opts);
    case "Proposal": {
      const p = decodeProposal(info.data);
      const { transactionPda } = pdas(new PublicKey(p.multisig), BigInt(p.transactionIndex));
      const t = await conn.getAccountInfo(transactionPda);
      return { address: addr, proposal: p, transactionPda: transactionPda.toBase58(), transaction: t ? decodeAccount(t.data) : null };
    }
    case "VaultTransaction":
      return { address: addr, transaction: decodeVaultTransaction(info.data) };
    case "ConfigTransaction":
      return { address: addr, transaction: decodeConfigTransaction(info.data) };
    default:
      return { address: addr, kind, note: "decoder not implemented for this account type" };
  }
}

export async function inspectMultisig(conn: Connection, pk: PublicKey, data: Uint8Array, opts: InspectOptions): Promise<MultisigReport> {
  const ms = decodeMultisig(data, pk);
  const vault0Lamports = await conn.getBalance(new PublicKey(ms.vault0));
  const latest = BigInt(ms.transactionIndex);
  const stale = BigInt(ms.staleTransactionIndex);
  const n = BigInt(opts.recent ?? 5);
  const from = latest - n + 1n > 1n ? latest - n + 1n : 1n;
  const proposals: ProposalSummary[] = [];
  for (let i = from; i <= latest; i++) {
    const { transactionPda, proposalPda } = pdas(pk, i);
    const [pInfo, tInfo] = await Promise.all([conn.getAccountInfo(proposalPda), conn.getAccountInfo(transactionPda)]);
    proposals.push({
      transactionIndex: i.toString(),
      proposalPda: proposalPda.toBase58(),
      transactionPda: transactionPda.toBase58(),
      proposal: pInfo ? decodeProposal(pInfo.data) : null,
      transaction: tInfo ? decodeAccount(tInfo.data) : null,
      stale: i <= stale,
    });
  }
  return { address: pk.toBase58(), multisig: ms, vault0Lamports, proposals };
}

/** Decode a fixture written by scripts/fetch-fixtures.js (a closed proposal rebuilt from its creating tx). */
export function inspectFixture(fixture: { ixDataBase64: string; [k: string]: unknown }) {
  const ix = decodeVaultTransactionCreateIx(Buffer.from(fixture.ixDataBase64, "base64"));
  const { innerMessageBytes, ...rest } = ix;
  return { fixture: { multisig: fixture.multisig, transactionIndex: fixture.transactionIndex, createSignature: fixture.createSignature }, ...rest };
}
