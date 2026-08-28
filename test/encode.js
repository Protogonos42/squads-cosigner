// Tiny encoder for the compact wire TransactionMessage (mirror of decodeVaultMessage),
// used to build synthetic vault messages for refusal-code tests.
const { PublicKey } = require("@solana/web3.js");

/**
 * @param {object} m
 * @param {string[]} m.accountKeys   base58 keys; first numSigners are signers,
 *   first numWritableSigners of those writable, then numWritableNonSigners writable non-signers
 * @param {number} m.numSigners
 * @param {number} m.numWritableSigners
 * @param {number} m.numWritableNonSigners
 * @param {{programIdIndex:number, accountIndexes:number[], data:Buffer}[]} m.instructions
 * @param {{table:string, writableIndexes:number[], readonlyIndexes:number[]}[]} [m.addressTableLookups]
 */
function encodeCompactMessage(m) {
  const parts = [];
  const u8 = (n) => parts.push(Buffer.from([n]));
  const u16 = (n) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    parts.push(b);
  };
  const pk = (s) => parts.push(new PublicKey(s).toBuffer());
  const u8vec = (arr) => {
    u8(arr.length);
    parts.push(Buffer.from(arr));
  };
  u8(m.numSigners);
  u8(m.numWritableSigners);
  u8(m.numWritableNonSigners);
  u8(m.accountKeys.length);
  for (const k of m.accountKeys) pk(k);
  u8(m.instructions.length);
  for (const ix of m.instructions) {
    u8(ix.programIdIndex);
    u8vec(ix.accountIndexes);
    u16(ix.data.length);
    parts.push(Buffer.from(ix.data));
  }
  const luts = m.addressTableLookups ?? [];
  u8(luts.length);
  for (const l of luts) {
    pk(l.table);
    u8vec(l.writableIndexes);
    u8vec(l.readonlyIndexes);
  }
  return Buffer.concat(parts);
}

/** Helpers to build instruction data. */
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

module.exports = { encodeCompactMessage, u64, u32 };
