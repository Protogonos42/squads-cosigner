# Maintenance log — upstream watch

The grant commitment is to keep decoders and fixtures current with Squads v4
changes. This file records each check: what upstream did, whether it touches
this tool, and what was changed here. Dates are UTC.

## 2026-08-28 — SDK package rename; on-chain program is immutable

**Upstream state checked.**
- Program `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` on mainnet: upgrade
  authority `None`, last deployed at slot 302,582,236. The on-chain layouts this
  tool decodes cannot change without a new program id. Any "upgrade" that
  matters would therefore be a *new deployment*, which the tool would refuse as
  an unknown program until `programs.ts` is taught it — that is the intended
  fail-closed behaviour.
- `Squads-Protocol/v4` commits since the last check: #199 (SECURITY.md contact
  → disclosure@sqds.io), #186 (TS SDK: `batchExecuteTransaction` now forwards a
  custom `programId` when deriving ephemeral signers; MUL-744), #187 (Rust SDK:
  `vault_transaction_execute` builds lookup-table metas from
  `message.address_table_lookups` in message order; MUL-753). Neither PR
  changes the program or any account layout.
- Relevance to this tool: `sign.ts` builds execute instructions with the TS
  SDK's `vaultTransactionExecute`, whose `accountsForTransactionExecute`
  already derives lookup tables from the stored message in message order
  (verified in both 2.1.2 and 2.1.4 bundles), so MUL-753 does not apply.
  The tool never calls `batchExecuteTransaction`, so MUL-744 does not apply.
  Unresolved lookup-table keys are still refused `REFUSED_UNSCREENABLE` by the
  `strictLookupTables` rule (default on).

**Change made here.**
- Dependency moved from `@squads-protocol/multisig` (last published 2.1.2,
  2024-08-30, no longer updated) to `@sqds/multisig` `^2.1.4` (2025-06-16),
  which is the package Squads now publishes. Same code lineage; 2.1.4 adds
  `TransactionBuffer` accounts/instructions (`transactionBufferCreate/Extend/
  Close`, `vaultTransactionCreateFromBuffer`) and `proposalCancelV2`, and
  compiles to native `async` instead of `__async` helpers.
- Build: clean. Tests: 48 pass, 1 skipped (same as before). Live `inspect` of
  a mainnet multisig with the new build: identical output.
- `TransactionBuffer` accounts (discriminator `5a2423db5de16e60`, 15 such
  accounts on mainnet at the time of the check) are now decoded
  (`decodeTransactionBuffer`; same day, second pass). A buffer is only a
  staging area — the resulting `VaultTransaction` is what a proposal points
  at and what this tool screens — so verdicts are unaffected and the rule
  engine never reads a buffer. `inspect` on a buffer address now reports
  multisig, creator, buffer/vault index, bytes uploaded vs. final size, the
  committed hash, and — only when the upload is complete — the staged
  message. Two fixtures were captured from mainnet accounts I do not control
  (`fixtures/mainnet/transaction-buffer/`): one partial upload (400/516
  bytes, decodes to no message) and one complete (889/889, one instruction
  behind a lookup table). The test recomputes sha256 of the staged bytes and
  checks it equals the account's `finalBufferHash`. 50 tests pass.

**Not changed, on purpose.**
- `npm audit --omit=dev` reports 9 advisories (4 high, 5 moderate), all
  transitive under `@solana/web3.js` 1.x (`bigint-buffer`, `uuid` via
  `jayson`, `@solana/buffer-layout-utils`, `spl-token`). The count is the same
  before and after the package move. `npm audit fix` (non-forced) resolves
  none; the forced fix would move to web3.js 2.x, which `@sqds/multisig` does
  not support. Left as is; re-checked at each maintenance pass.
