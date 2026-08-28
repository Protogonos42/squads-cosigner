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

## 2026-08-28 — third pass: config-rule gap (time lock, spending limits)

**Trigger.** Reading Custos Nox (cryptoyasenka/custos-nox, MIT, a monitor for
Squads/SPL-Governance config attacks) and its reconstruction of the Drift
April 2026 chain: the Squads Security Council was moved to 2-of-5 "with zero
timelock" before the pre-signed withdrawal ran. Checking my own rule against
that chain: `config.membership` refused `AddMember`, `RemoveMember`,
`ChangeThreshold`, `SetRentCollector` — and nothing else. Two of the seven
Squads v4 `ConfigAction` kinds were silently allowed once an operator opted
into `allowConfigTransactions: true`.

**Changed.**
- `config.timelock`: `SetTimeLock` is `REFUSED_THEFT_SHAPED` unless the
  multisig's current `timeLock` was read from chain and the new value is not
  shorter. `checkWithSimulation` now fetches the multisig account for
  ConfigTransactions; if that fetch fails the current value is unknown and
  the rule refuses (conservative by construction).
- `config.spendingLimit`: `AddSpendingLimit` is always `REFUSED_THEFT_SHAPED`
  — a spending limit lets the listed members move funds with no proposal, no
  threshold and no co-signer. `RemoveSpendingLimit` only tightens; allowed.
- Default rules (`allowConfigTransactions: false`) are unchanged: every
  ConfigTransaction was and is `REFUSED_CONFIG_CHANGE`. The gap only mattered
  for operators who opted in.
- Two new tests (shortening / unknown / lengthening / equal; add / remove
  spending limit). 53 tests, 52 pass, 1 skipped. Live: `check` on the mainnet
  `RemoveMember` proposal from the README worked example still returns
  `REFUSED_CONFIG_CHANGE` under default rules and `REFUSED_THEFT_SHAPED`
  (`config.membership`) when opted in, with the multisig fetch in the path.
- `docs/threat-model.md` gains two rows.

## 2026-08-28 — fourth pass: durable-nonce instructions

Reading [custos-nox](https://github.com/cryptoyasenka/custos-nox)'s `privileged-nonce` / `stale-nonce-execution` rows against `src/programs.ts`: System tags 4–7 and 12 (nonce advance / withdraw / initialize / authorize / upgrade) were not decoded. They surfaced as `system.4`…`system.7` and hit the `interpretable` fallback — refused by default, which is safe, but under `trustSimulationForAllowedPrograms: true` they passed with no static read, and simulation diffs are balance-only, so an `AuthorizeNonceAccount` handing a vault-signed nonce to another key would not have been caught. Now decoded with the correct flags: authorize/initialize set `changesAuthority` (refused by `no-authority-handoff` unless the new authority is the vault), withdraw sets `movesLamports` (destination + cap rules), advance/upgrade are benign. Three tests added. Default rules unchanged; the default verdict for these shapes tightens from `REFUSED_UNSCREENABLE` to `REFUSED_THEFT_SHAPED`, and a legitimate vault nonce advance now approves instead of being unscreenable.

## 2026-08-28 — fifth pass: Token-2022 extension instructions

Generalising the catalogue method beyond Squads neighbours: checked the Token-2022 extension set (transfer fee, confidential transfer, permanent delegate, transfer hook, `WithdrawExcessLamports`) against `explainToken` in `src/programs.ts`. Every tag ≥ 21 fell to the `interpretable` fallback — refused by default, but unread under `trustSimulationForAllowedPrograms: true`. Two of those shapes are not caught by a balance diff at all: a **confidential transfer** (tag 27 sub 7) moves an encrypted balance while the visible `amount` field stays put, and **`WithdrawExcessLamports`** (tag 38) from a vault-owned token account leaves the vault PDA's lamports untouched (`simulate.ts` diffs only the PDA). A third, `transferCheckedWithFee` (26 sub 1), *is* visible to the diff but had no static read, so `destinations` and `own-tokens-only` did not apply to it. Now decoded: 26 sub 0–5 (sub 1–3 set `movesTokens`), 27/37/42 set a new `confidential` flag → `no-confidential-balances` refuses as `REFUSED_UNSCREENABLE` whenever the vault or a vault-owned account is in the instruction, independent of the trust-simulation opt-in; 38 sets `movesLamports` with `lamports: null` (amount not in data). Four tests added. Default rules unchanged: the default verdict for all of these stays `REFUSED_UNSCREENABLE`; the only behavioural change under defaults is that a `transferCheckedWithFee` to a listed destination now approves instead of being unscreenable. Not modelled, and said so in the threat model: mint-level properties (permanent delegate, transfer hook) of tokens the vault already holds — those act without a proposal and are a holdings question, not a proposal one. 60 tests, 59 pass, 1 skipped.
