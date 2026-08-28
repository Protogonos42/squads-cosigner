# Threat model

What `squads-cosigner` defends against, what it does not, and what you must
hold true yourself for the defence to mean anything. Written for an operator
deciding whether to put the tool's key on a real multisig. Short on purpose;
where a claim is backed by a test or a mainnet transaction, it says so.

## The setting

A Squads v4 multisig with threshold ≥ 2. One member is an **automation** —
a bot, a CI job, an AI agent — holding a key with `Initiate + Vote`. Another
member is **this tool**, holding a key with `Vote + Execute`. Any further
members (humans, a recovery key) are yours.

The question the tool answers is narrow: *given that the automation may be
wrong, compromised, or adversarial, what is the most it can take from the
vault?* The answer the tool tries to give: no more than the rules you wrote
allow, per proposal, and never the vault itself.

## What the tool defends against

Everything below is decided by the rules file and the decoded inner
transaction, not by a model or a prompt. Each row names the rule that
fires and its verdict; all are exercised by offline fixture tests
(`npm test`) and, for the APPROVE path, by two unattended mainnet co-signs
(see `docs/updates/`).

| Attack from the proposer | Defence | Verdict |
|---|---|---|
| Proposes a transfer to an address you did not list | `allowDestinations` / `denyDestinations` on the recipient account of every System, Token and ATA transfer (the vault and accounts the proposal itself creates for the vault are always allowed) | `REFUSED_COUNTERPARTY` |
| Proposes a transfer larger than your per-proposal cap | `maxLamportsOut`, `maxTokenOut` — checked statically on the decoded amounts **and** on the simulated pre/post balances of every vault-owned account | `REFUSED_OVER_CAP` |
| Splits a large drain into many instructions in one proposal | Caps are per proposal, summed across instructions | `REFUSED_OVER_CAP` |
| Adds itself as a member, raises its own permissions, lowers the threshold, removes you, changes the rent collector | Every `ConfigTransaction` is refused unless `allowConfigTransactions: true`; even then `AddMember`, `RemoveMember`, `ChangeThreshold` and `SetRentCollector` are refused (`config.membership`) | `REFUSED_CONFIG_CHANGE` / `REFUSED_THEFT_SHAPED` |
| Shortens the time lock so a bad proposal executes before anyone can reject it (the Drift, April 2026 chain went through "zero timelock") | `SetTimeLock` is refused unless the multisig's current time lock was read from chain and the new value is not shorter (`config.timelock`) | `REFUSED_THEFT_SHAPED` |
| Adds a spending limit, so listed members can move funds with no proposal, no threshold and no co-signer | `AddSpendingLimit` is always refused (`config.spendingLimit`); `RemoveSpendingLimit` only tightens and is allowed | `REFUSED_THEFT_SHAPED` |
| Hands the authority of a nonce account to another key, so a pre-signed transaction can be executed later without any proposal (the Drift, April 2026 chain executed its withdrawal from a nonce under the attacker's key — see [custos-nox](https://github.com/cryptoyasenka/custos-nox), whose Drift-chain table is the source for this row and the two above) | `system.initializeNonceAccount` / `system.authorizeNonceAccount` on a vault-owned or vault-signed nonce are refused unless the new authority is the vault itself (`no-authority-handoff`); `system.withdrawNonceAccount` is a lamport transfer and goes through destination and cap rules; `advanceNonceAccount` / `upgradeNonceAccount` are read as benign | `REFUSED_THEFT_SHAPED` |
| Calls back into the Squads program from inside the vault transaction (CPI config change, nested execute) | `no-squads-cpi` | `REFUSED_CONFIG_CHANGE` |
| `system.assign`, `set_authority`, `upgrade`, or closing an account with its lamports sent elsewhere — any instruction that hands a vault-controlled account to another key | `no-assign`, `no-authority-handoff`, `no-program-upgrade`, `close-to-foreign`, plus the simulation's ownership diff (`simulated-ownership-change`) which catches the same shape through programs the decoder does not know | `REFUSED_THEFT_SHAPED` |
| Creates a mint, mints tokens, or moves tokens whose authority is not the vault (i.e. someone else's) | `no-mint-creation`, `no-minting`, `own-tokens-only` | `REFUSED_MINT_CUSTODY` |
| Invokes a program you did not allow | `allowPrograms` is an allow-list; unlisted programs are never approved | `REFUSED_UNSCREENABLE` |
| Invokes an allowed program with instruction data the decoder cannot interpret | `interpretable` — an instruction the tool cannot positively read is never approved | `REFUSED_UNSCREENABLE` |
| Hides counterparties behind an address lookup table | Tables are resolved on-chain before evaluation; with `strictLookupTables: true` any unresolved key refuses the whole proposal | `REFUSED_UNSCREENABLE` |
| Proposes something the tool cannot fetch or simulate (RPC error, malformed account) | Fetch/simulation failure is a refusal, not a retry-and-approve | `REFUSED_UNSCREENABLE` |

Two structural properties matter more than any single rule:

1. **Fail closed.** `APPROVE` requires that *every* instruction was
   positively interpreted and passed *every* rule. There is no "unknown, so
   allow" path in `src/rules.ts` unless you opt in with
   `trustSimulationForAllowedPrograms` (see below). Verdict ordering is fixed
   (CONFIG > THEFT > MINT > COUNTERPARTY > OVER_CAP > UNSCREENABLE > APPROVE),
   so a proposal that trips several rules reports the most structural one.
2. **The gate is in-process, at signing time.** `approve` and `execute`
   re-run the full check on the on-chain state immediately before building
   and signing the outer transaction. A proposal the tool inspected earlier
   is not trusted later; the decision is remade from what is on chain now.

And one property that comes from Squads, not the tool: the proposer's key
has no `Execute` permission. Even a proposal it approves itself with a
forged second vote cannot be executed by it. If the tool refuses, the
proposal simply sits until a human votes or it goes stale.

## What the tool does not defend against

Be honest with yourself about these before relying on it.

**Compromise of the tool's own key or host.** The key the tool holds can
approve and execute. If an attacker has that key *and* the proposer's key,
they have two signatures and the rules are irrelevant. Run the tool on a
host the proposer cannot reach, with the key readable only by the tool's
user. The rules file is trusted input — if the attacker can edit it, they
can allow-list themselves. Treat `rules.json` like the key.

**Threshold ≥ 2 with only these two members.** The tool is one vote. If your
threshold is 2 and the members are {proposer, tool}, the tool's key is the
whole defence. Adding a third human member with `Vote` and keeping threshold
2 does not weaken the tool's veto but does give you a recovery path when it
refuses something you actually wanted.

**Slow drains within the cap.** The cap is per proposal, and the tool has
no rate limit across proposals. A compromised proposer can propose the
maximum every block-time until the vault is empty. Set the cap to what you
are willing to lose per proposal *times* the number of proposals you would
fail to notice, and watch the audit log. There is no rolling-window cap;
if you need one, it has to live outside the tool for now.

**Simulation is not execution.** `check` simulates the inner vault message
as a standalone transaction with `sigVerify: false`, not the real
`vault_transaction_execute` (which the program refuses to run before the
proposal is approved). Two known differences: the inner instructions run
one CPI level shallower, and the fee payer differs. A program whose
behaviour depends on its call depth or on the fee payer could behave
differently at execution than in simulation. The static rules still apply
regardless; only the balance/ownership diff is simulation-derived.

**State changes between check and execution.** Simulation reads chain
state at check time. A program that reads mutable state (an oracle price,
a pool balance) may move a different amount when actually executed. The
static caps on decoded amounts are unaffected; the simulated caps could be
stale. For programs where this matters, keep them off `allowPrograms`.

**Semantic misuse of allowed programs.** If you allow-list a DEX program,
the tool will approve a swap to an allowed destination at a terrible price.
The tool checks *who* and *how much*, not *whether the trade was wise*.
It is a veto against theft-shaped and out-of-policy proposals, not a
trading guard.

**Time-lock bypass, stale proposals, rent games.** Squads' own time lock
and stale-index rules apply as normal; the tool does not add to them. Rent
returned when a proposal is closed goes to the multisig's `rentCollector`,
which the tool does not control and cannot change (that would be a
`ConfigTransaction`).

**Token-2022 extensions.** Three extension families are decoded because
they can move or hide a vault's value: `TransferFeeExtension` (tag 26 —
`transferCheckedWithFee` and the withheld-fee withdrawals count as token
transfers: `own-tokens-only`, `destinations`, `maxTokenOut`);
`ConfidentialTransferExtension` (27, plus 37 and 42) — balances are
ElGamal-encrypted, so the amount is neither in the instruction data nor in
a simulation diff of the visible `amount` field; any confidential
instruction the vault takes part in is `REFUSED_UNSCREENABLE`
(`no-confidential-balances`), and `trustSimulationForAllowedPrograms` does
not lift that, because there is nothing for the simulation to see; and
`WithdrawExcessLamports` (38) — a lamport outflow under the vault's
signature, subject to `destinations` (the amount is not in the data, so the
static cap does not see it; the simulated cap does only when the source is
the vault PDA itself). Every other extension instruction (CPI guard, memo
transfer, interest-bearing, metadata/group pointers, reallocate, …) still
falls to `interpretable` → `REFUSED_UNSCREENABLE` by default. Two things
remain out of scope by construction: a *mint's* properties (a permanent
delegate or transfer hook on a token the vault already holds lets that
mint's authority act with no proposal at all — the tool screens proposals,
not holdings), and a transfer hook's side effects on a decoded transfer.

**RPC trust.** The tool believes the RPC endpoint it is given. A malicious
RPC can lie about account state, lookup-table contents and simulation
results. Use an RPC you run or one you would trust with the same money.
The audit log records what the tool *saw*; it cannot record what was true.

**Availability.** If the tool is down, nothing gets approved. That is the
designed failure mode (fail closed), but it means an outage of the tool is
an outage of the automation's spending. The `watch` daemon has no
built-in supervision; run it under something that restarts it.

## What you must hold true

- The tool's key is on a host the proposer cannot reach.
- `rules.json` is as protected as the key, and reviewed when changed.
- `strictLookupTables: true` unless you have a specific reason.
- `allowPrograms` contains only programs whose *every* instruction you
  would be content to see executed to an allowed destination at the cap.
- `allowConfigTransactions: false` — the default — stays false.
- `allowDestinations` is non-empty. An empty or absent list means *any*
  destination not in `denyDestinations` is permitted; that is a
  deny-list posture and much weaker.
- `trustSimulationForAllowedPrograms` stays unset. It is an opt-in that
  lets an uninterpretable instruction to an *allowed* program pass on the
  strength of the simulation diff alone; caps and ownership checks still
  apply, but the static "every instruction positively read" guarantee is
  gone for that program.
- Someone reads the audit log (`verify-log` checks its chain) at a cadence
  shorter than the time it would take to drain the vault at the cap.
- The multisig has at least one human `Vote` member besides the tool, so a
  false refusal is recoverable without touching the tool.

## Reporting

If you find a proposal shape the rules approve that they should not,
open an issue at <https://github.com/Protogonos42/squads-cosigner/issues>
with the proposal address (devnet is fine) and the rules file. The
promise in `docs/updates/` is an answer within two days and a new rule
case for any real refusal shape.
