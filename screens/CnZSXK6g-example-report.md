# Treasury screen — CnZSXK6gtWVBnLtzyF6Fem4zrfPGAwwfdf28nvw3Au2o

Generated 2026-08-28T22:41:31.929Z by [squads-cosigner](https://github.com/Protogonos42/squads-cosigner) `scripts/screen.js`, read-only, from public chain state via `https://api.mainnet-beta.solana.com`. Written by an AI agent (Protogonos); verify anything you act on.

## Configuration

| | |
|---|---|
| Vault (index 0) | `Eb6Xa2a2VgFhPqJ62WJo45WVfF355LTAdGKWqJL5J5ji` |
| Threshold | 4 of 6 |
| Time-lock | 0s |
| Config authority | none (changes need a config proposal) |
| Rent collector | none — closed proposals' rent is unrecoverable |
| Transactions so far | 6 (screened 1..6) |

### Members

| Key | Initiate | Vote | Execute | Meaning |
|---|:-:|:-:|:-:|---|
| `3uM6Zx1tc5v3gXA1cvEu89K2tVvBUDpVJES1Yp71FpbT` | ✓ | ✓ | ✓ | full member: can propose, approve and execute alone if threshold allows |
| `4KwPEBiSNcjr6CZRT5uHyhQdLhszL1Dj2Eyga9RsfPGF` | ✓ | ✓ | ✓ | full member: can propose, approve and execute alone if threshold allows |
| `5Mo1xrV9pgHqmW5zB5gSBy7pT4hLck6jGSdkqYbap83K` | ✓ | ✓ | ✓ | full member: can propose, approve and execute alone if threshold allows |
| `7oSnQUpwQu6R2UT11qEuRbGEFPZfgt3NKJMFJgzMihG1` | ✓ | ✓ | ✓ | full member: can propose, approve and execute alone if threshold allows |
| `B7GLoHLNMmetq7P1UBzJAjjxyHjF7xRo6VqkKhKJMsD1` | ✓ | ✓ | ✓ | full member: can propose, approve and execute alone if threshold allows |
| `CiMjzccrF3SGZr8EoXMN7k5j6zJhQB1g3ajXmjmLuRoG` | ✓ | ✓ | ✓ | full member: can propose, approve and execute alone if threshold allows |

6 member(s) can vote; 4 approval(s) execute a proposal.

## Proposal history

| # | Created | Type | Status | Instructions | Verdict under observed rules | Lamports out | Note |
|---|---|---|---|---|---|---|---|
| 1 | 2026-04-15 | config | Active | RemoveMember | `REFUSED_CONFIG_CHANGE` | 0 | ConfigTransaction with actions [RemoveMember] |
| 2 | 2026-04-15 | config | Active | AddMember | `REFUSED_CONFIG_CHANGE` | 0 | ConfigTransaction with actions [AddMember] |
| 3 | 2026-04-15 | config | Active | AddMember | `REFUSED_CONFIG_CHANGE` | 0 | ConfigTransaction with actions [AddMember] |
| 4 | 2026-04-15 | config | Active | RemoveMember | `REFUSED_CONFIG_CHANGE` | 0 | ConfigTransaction with actions [RemoveMember] |
| 5 | 2026-04-15 | config | Active | AddMember | `REFUSED_CONFIG_CHANGE` | 0 | ConfigTransaction with actions [AddMember] |
| 6 | 2026-04-15 | config | Active | RemoveMember | `REFUSED_CONFIG_CHANGE` | 0 | ConfigTransaction with actions [RemoveMember] |

Verdict counts: `REFUSED_CONFIG_CHANGE` 6.

## Things to look at

- 6 config transaction(s) — membership/threshold/time-lock changes: #1 [RemoveMember] Active; #2 [AddMember] Active; #3 [AddMember] Active; #4 [RemoveMember] Active; #5 [AddMember] Active; #6 [RemoveMember] Active.
- 6 proposal(s) still open: #1 Active, #2 Active, #3 Active, #4 Active, #5 Active, #6 Active. Each holds ~0.0077 SOL of rent until closed.

## Observed rules

`rules.observed.json` beside this file allows exactly the programs and destinations this treasury has used (0 programs, 0 destinations), refuses config changes and mutable lookup tables, and sets no caps. Against the 6 proposals screened it approves 0 and refuses 6; every refusal is in the table with its reason. **It is a starting point, not a policy**: tighten destinations to the ones you still pay, add `maxLamportsOut`/`maxTokenOut` caps, and decide about each refused-but-executed row.

## Method

For each index the create instruction was recovered from the transaction PDA's signature history, so proposals whose accounts have been closed are still decoded from the bytes members actually approved. Status comes from the live proposal account where it exists, otherwise from execute/cancel/close signatures. Instructions are decoded by the same engine the co-signer uses; anything it cannot positively interpret is reported as `REFUSED_UNSCREENABLE`, never guessed.
