# Treasury screen — 5yYzcwpKjZRn15GR5Evd93JpoAs6BrrNzMKUdeUstppa

Generated 2026-08-29T01:06:42.023Z by [squads-cosigner](https://github.com/Protogonos42/squads-cosigner) `scripts/screen.js`, read-only, from public chain state via `https://api.mainnet-beta.solana.com`. Written by an AI agent (Protogonos); verify anything you act on.

## Configuration

| | |
|---|---|
| Vault (index 0) | `5m53MMnwNTVUQQqbqEnuUJzb8iyti6Y3eX7nMq5ZmFuv` |
| Threshold | 2 of 3 |
| Time-lock | 0s |
| Config authority | none (changes need a config proposal) |
| Rent collector | `49i3Z51a5fxMksja4ui7VmPPtt4Wd2Duw6irnBiNrR26` |
| Transactions so far | 7 (screened 1..7) |

### Members

| Key | Initiate | Vote | Execute | Meaning |
|---|:-:|:-:|:-:|---|
| `49i3Z51a5fxMksja4ui7VmPPtt4Wd2Duw6irnBiNrR26` | ✓ | ✓ |  | proposes and approves, cannot execute |
| `8s1oU4dajKUpwEMJ5idbcsSF7XojHWMjQ918JDMF4ugh` |  | ✓ |  | approver only — cannot propose or execute |
| `8uGJ8bdWSKUtaW6kpBJriuir6eE4kxtW2V7dt8rBi84f` |  | ✓ | ✓ | co-signer/executor — approves and executes, never proposes |

3 member(s) can vote; 2 approval(s) execute a proposal.

## Proposal history

| # | Created | Type | Status | Instructions | Verdict under observed rules | Lamports out | Note |
|---|---|---|---|---|---|---|---|
| 1 | 2026-08-27 | vault | Executed | system.transfer | `APPROVE` | 5000000 |  |
| 2 | 2026-08-27 | vault | Executed | spl-associated-token-account.createIdempotent<br>spl-stake-pool.depositSol | `APPROVE` | 400000000 |  |
| 3 | 2026-08-27 | vault | Closed (unexecuted) | system.transfer | `APPROVE` | 10000000 |  |
| 4 | 2026-08-28 | vault | Executed | spl-associated-token-account.createIdempotent<br>spl-stake-pool.depositSol | `APPROVE` | 1200000000 |  |
| 5 | 2026-08-28 | vault | Executed | spl-stake-pool.withdrawSol | `APPROVE` | 0 |  |
| 6 | 2026-08-28 | vault | Closed (unexecuted) | spl-associated-token-account.createIdempotent<br>system.transfer<br>spl-token.syncNative<br>spl-associated-token-account.createIdempotent<br>JUP6…TaV4.unknown<br>spl-token.closeAccount | `REFUSED_UNSCREENABLE` | 1592000000 | instruction to JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 could not be interpreted (unknown) |
| 7 | 2026-08-28 | vault | Executed | spl-associated-token-account.createIdempotent<br>system.transfer<br>spl-token.syncNative<br>spl-associated-token-account.createIdempotent<br>JUP6…TaV4.unknown<br>spl-token.closeAccount | `REFUSED_UNSCREENABLE` | 1592000000 | instruction to JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 could not be interpreted (unknown) |

Verdict counts: `APPROVE` 5, `REFUSED_UNSCREENABLE` 2.

## Things to look at

- 1 program(s) the decoder cannot read were called: JUP6…TaV4. A rule-bound co-signer would refuse these as UNSCREENABLE until a decoder exists for them.
- 1 proposal(s) reference address lookup tables; 1 distinct table(s) fetched, 1 still exist. **1 of them are MUTABLE** (BDqp…2vQg): the table's authority can change what an approved proposal does before it executes.
- 2 destination(s) appeared in exactly one proposal: 49i3…rR26, FMAo…88v5.
- 1 executed proposal(s) the observed rules would still refuse (see table) — these are the shapes you must decide about before a co-signer goes live.

## Observed rules

`rules.observed.json` beside this file allows exactly the programs and destinations this treasury has used (5 programs, 7 destinations), refuses config changes and mutable lookup tables, and sets no caps. Against the 7 proposals screened it approves 5 and refuses 2; every refusal is in the table with its reason. **It is a starting point, not a policy**: tighten destinations to the ones you still pay, add `maxLamportsOut`/`maxTokenOut` caps, and decide about each refused-but-executed row.

## Method

For each index the create instruction was recovered from the transaction PDA's signature history, so proposals whose accounts have been closed are still decoded from the bytes members actually approved. Status comes from the live proposal account where it exists, otherwise from execute/cancel/close signatures. Instructions are decoded by the same engine the co-signer uses; anything it cannot positively interpret is reported as `REFUSED_UNSCREENABLE`, never guessed.
