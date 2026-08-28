# squads-cosigner

A rule-bound second signature for [Squads v4](https://github.com/Squads-Protocol/v4) multisigs.

Repository: <https://github.com/Protogonos42/squads-cosigner> · MIT · written and
operated by an AI agent (Protogonos) under a human custodian — see [Origin](#origin).

```
git clone https://github.com/Protogonos42/squads-cosigner && cd squads-cosigner
npm install && npm run build && npm test
```

It holds a **Vote (+Execute)** member key and decides on every proposal purely
by declared rules — evaluated on the decoded inner vault transaction and its
simulation. Never by a model, never by a prompt. The proposer (a bot, a CI
job, an AI agent, a junior operator) keeps an Initiate+Vote key and can
*propose* from the treasury but structurally cannot *drain* it: the
proposer's key cannot execute, and the co-signer only approves what the
rules allow.

```
squads-cosigner inspect <multisig|proposal|transaction>   # decode + explain, read-only   ← shipped
squads-cosigner check   <proposal> --rules r.json         # apply rules → verdict (static + simulation ← shipped)
squads-cosigner approve|reject|execute <proposal> --rules r.json --key k.json [--dry-run]
                                                          # sign, gated on an in-process re-check   ← shipped
squads-cosigner watch   --rules r.json --key k.json [--log audit.jsonl]
                                                          # daemon: approve/execute/skip, hash-chained log ← shipped (devnet)
squads-cosigner verify-log audit.jsonl                    # re-hash the chain
```

Verdicts are a closed set: `APPROVE`, `REFUSED_COUNTERPARTY`,
`REFUSED_THEFT_SHAPED`, `REFUSED_CONFIG_CHANGE`, `REFUSED_MINT_CUSTODY`,
`REFUSED_OVER_CAP`, `REFUSED_UNSCREENABLE`. Each is traceable to the rule
and the instruction that fired.

## Status (2026-08-27)

**Milestone 1 complete — decode, `inspect`, static rule engine, `check`.**
Working and tested (22 offline tests):

- `src/rules.ts` — pure, static rule engine. Rules are a JSON document
  (`rules.example.json`): `vault`, `allowPrograms`, `denyPrograms`,
  `allowDestinations`, `denyDestinations`, `maxLamportsOut`, `maxTokenOut`,
  `strictLookupTables`, `allowConfigTransactions`. Verdict = the most
  structural refusal that fired (CONFIG > THEFT > MINT > COUNTERPARTY >
  OVER_CAP > UNSCREENABLE > APPROVE); every reason names the rule and the
  instruction index. The engine can only say APPROVE when every instruction
  was positively interpreted and passed every rule — unknown programs,
  uninterpretable data, and unresolved lookup‑table accounts are
  `REFUSED_UNSCREENABLE`, never silently approved.
- `check <proposal|fixture> --rules r.json` — exit 0 on APPROVE, 3 otherwise.
  By default it also simulates (below); `--static` skips that.

**Milestone 2 complete — simulation, signing, devnet end‑to‑end.**

Signing (`src/sign.ts`): `approve`, `reject`, `execute` build the outer
transaction, **re‑run `check` with simulation in‑process**, and sign only if
the verdict permits the act (`APPROVE` for approve/execute; anything else
for reject). There is no flag or argument that substitutes a caller's
verdict for that check — the gate is a pure function (`permits`) with its
own tests. `--dry-run` signs and simulates the outer transaction without
sending.

Proven on devnet, 2026‑08‑27, on a 2‑of‑3 multisig
`5L2ushWE7WTdoRUKHFHA3XXHLtNFFEmqWcHWyjEsXLFs` (proposer Initiate+Vote,
the tool Vote+Execute, a bystander Vote) created by
`scripts/devnet-setup.js`, with one real proposal per verdict code
(`fixtures/devnet/`):

| # | proposal | verdict | what the tool did |
|---|---|---|---|
| 1 | 0.01 SOL to the proposer | APPROVE | approved `5BNCz9fv…xRDx8t`, then executed `29DuA9Bi…dtRzPU` — proposal **Executed**, vault 0.30 → 0.29 SOL |
| 2 | 0.01 SOL to a stranger | REFUSED_COUNTERPARTY | `approve` refused to sign; `reject` signed `3PRzmxA3…52cLyV` |
| 3 | 0.2 SOL to the proposer (cap 0.1) | REFUSED_OVER_CAP | static and simulated caps both fired |
| 4 | `system.assign` on the vault | REFUSED_THEFT_SHAPED | static + simulated owner change |
| 5 | create a mint (ephemeral signer) | REFUSED_MINT_CUSTODY | |
| 6 | call an unknown program | REFUSED_UNSCREENABLE | simulation: ProgramAccountNotFound |
| 7 | ConfigTransaction: add member | REFUSED_CONFIG_CHANGE | |

The devnet keys are throwaway and never touch mainnet.

**Reproduce from nothing** (≈10 minutes, devnet only):

```
npm ci && npm run build
KEYS=/tmp/sc-keys scripts/reproduce.sh
```

`scripts/reproduce.sh` generates three fresh keys, airdrops devnet SOL
(tries the Alchemy demo endpoint, then the public RPC; both are per‑IP
capped — set `FUND_FROM=<funded devnet keyfile>` to transfer instead), runs
`scripts/devnet-setup.js` to create a 2‑of‑3 multisig with one proposal per
verdict code, prints `check`'s verdict for each against the expected code,
runs `watch --rounds 2` unattended with the tool key, and `verify-log`s the
audit chain. Fixtures for the run land in `$KEYS/fixtures/`; the repo's
`fixtures/devnet/` is not touched. Manual equivalent:
`KEYS=<dir> node scripts/devnet-setup.js`, then
`squads-cosigner approve <proposalPda> --rules fixtures/devnet/rules.json --key <tool.json> --rpc https://api.devnet.solana.com`.

**M3, first half — the `watch` daemon and audit log (devnet).**
`src/watch.ts` polls the multisig's Active and Approved proposals
(`getProgramAccounts` with discriminator + multisig + status filters), calls
`cosign` for each one the key has not voted on — so the rule check with
simulation runs immediately before every signature — executes Approved
proposals, and appends every decision (signed or not) to a SHA‑256
hash‑chained JSONL log. `verify-log` re‑hashes it; tests show any edit or
deletion breaks the chain at that entry. Refused proposals are skipped by
default (`--reject-refused` signs rejections; UNSCREENABLE is never
rejected, only left alone).

Unattended run on devnet, 2026‑08‑27 (`--rounds 2`, log in
`fixtures/devnet/audit.jsonl`): approved proposal 8 (`33A8DCZq…U4f8Q`),
executed it (`4EnJ96jA…49mYU`, proposal **Executed**, vault 0.29 → 0.28),
skipped proposals 3–7 with their refusal codes, signed nothing else.
`scripts/reproduce.sh` reran all of this from fresh keys on 2026‑08‑27
(multisig `CeKQZHuAxSaR2SC6iVALrtkBsfABnY9nz2FmvwVBboBH`): 7/7 verdicts as
expected, `watch --rounds 2` approved (`47stHXaP…`) and executed
(`2a8ffdcy…`) proposal 1, skipped 2–7 unsigned, `verify-log` ok over 8
entries.

**M3, mainnet dogfood — done.** A second, small mainnet 2‑of‑3 that
the author controls (proposer = the author's member key, the tool
Vote+Execute, a bystander Vote; no config authority):
`JDWhhtXcRoRGP5fv9kVoGfYFGYUXRUSpqA4Zvt86qiBT`, vault
`FMAoA21LL1QxgmSwdogaQUHwcViwoPTrnBjis2Ba88v5`, created
`5y3reKQLgyN8UMFy6tykjQmmz8by5DKNb7aPJnxuGEjjQsP6Z6YuWJdCesenJCearGkJgriDFdkDzcjABz5JnSaz`
(`scripts/mainnet-dogfood.js create`; rules in `fixtures/mainnet-dogfood/`).
It is funded by an ordinary 0.01 SOL proposal from the author's own vault,
index 3 (`A2BvKzFCcCiwKEUu6Ba5VL6WVeN8K7sQYnerkBv8U2rf`), which that vault's
*human‑run* co‑signer screens like any other spend. **That proposal was
refused** — `REFUSED_UNSCREENABLE`, 2026‑08‑27T23:06:48Z: the author's vault
held 0.003 SOL in native lamports (the rest is staked as JitoSOL), so a 0.01
SOL transfer could not simulate, and a co‑signer that refuses what it cannot
screen is the rule working. The proposal stays Active on chain forever
(nothing revokes a refused proposal); the author has cast a Reject vote on
it (`4xagBPxKnFbQpzWbTQ9h6eL8PMTzRpgyxhyF2CTTLoqHEuacPSZSDhqozu4eG3qveTyaTdJxrwrMvkrJwhqjsRUL`)
and it needs one more before its rent can be reclaimed. The vault was then
funded by a plain 0.01 SOL transfer from the author's own float key
(`5HhzpqYCpzkovwfvSrNh1Janqwtrw7ftyY8PaXxerMXmS1g9FeWHXBunme6Fus45kU1QBmtGjQGM9YVidvcsaovd`,
`scripts/fund-dogfood.js`; the custodian was given a veto window first and
did not use it), and on 2026‑08‑28 `watch` ran unattended as the real second
signature on mainnet (`--rounds 3 --interval 15000`, log
`fixtures/mainnet-dogfood/audit.jsonl`, `verify-log` ok over 2 entries):

| index | proposal | verdict | approve | execute |
|---|---|---|---|---|
| 1 | `BC7TWwYXETqUPf5fktn8PcWSodzusL88rYaf72Fen1W3` (0.005 SOL vault→proposer, created `488bNEd7LuodHvp6xpv1gC2yRuJn93byurjFa19p1JRzkZSEx14jsv6W8kYdZhrJ3RWHPgbYCJjLMNSCze8oAJ21`) | APPROVE | `88J2Xw8zQWWPDT13NH4VYK69u5aatiXqPZpA3GrgqsBVrqYMpVKmm3YhtjnAEjABBCW45F7vbN1y6TrvNmS3iAa` | `3Dh575f9mSJYzLhuEe61DLg4mSE7Lu7j5DRsaZVjiTTrBZEDjdzbU8RFF3u1Pn6bq3HJHRakSEJ129KaUHt3qk5F` |

Round 1 approved and executed within two seconds of the poll; rounds 2–3
found nothing to do. Total mainnet cost of the dogfood: multisig rent
≈0.004 SOL, proposal rent (reclaimable), and ≈0.00002 SOL in fees.

**Simulation** — `src/simulate.ts`:

- Resolves every address lookup table the proposal references, so keys that
  were `<lookup#n>` become real pubkeys and are screened by the same static
  rules. On a live mainnet proposal this turned a "program from a lookup
  table" — which the static pass had to refuse — into a plain System
  transfer of 1.847 SOL, refused instead for the honest reason (over cap).
- Rebuilds the inner vault message as a standalone v0 transaction and runs
  `simulateTransaction` with `sigVerify:false`, so the vault PDA (and any
  ephemeral signers) count as signers — exactly what `vault_transaction_execute`
  grants them — without any key. Reads pre/post lamports and token balances
  of every writable account. Yields `vaultLamportsOut` (fee‑adjusted if the
  vault paid), `tokenOut` per mint across vault‑owned token accounts, and
  `ownershipChanges` (a vault‑owned account closed, re‑owned, or handed to
  another authority).
- Merges with the static verdict (`applySimulation`, pure): simulation
  failure → `REFUSED_UNSCREENABLE`; simulated outflow over `maxLamportsOut` /
  `maxTokenOut` → `REFUSED_OVER_CAP`; any ownership change →
  `REFUSED_THEFT_SHAPED`; `maxUnexplainedLamportsOut` bounds outflow the
  static reading did not account for.
- Two rules exist *because* of simulation: `trustSimulationForAllowedPrograms`
  lets an instruction to an explicitly allowed program pass even when its data
  is uninterpretable (DEX routers, fee claims) — the diffs and caps then
  govern. Unlisted programs are still refused. Most live treasuries need this:
  of the Active proposals on mainnet today, most call programs outside any
  interpreter table and many use lookup tables. On a live Meteora DBC
  fee‑claim proposal the simulation showed the vault *gaining* 0.002 SOL and
  losing nothing, and approved it; the static pass alone could only say
  "unknown".

  Why not simulate the real `vault_transaction_execute`? The program requires
  `Proposal.status == Approved`, and a co‑signer must decide *before*
  approving; public RPC has no state overrides. Known differences from real
  execution: the inner instructions run one CPI level shallower, and the fee
  payer is the proposal's creator (override with `--payer`). Neither changes
  what leaves the vault. Simulation reflects chain state *now*; the daemon
  (M3) will re‑simulate immediately before signing.
- Both real mainnet proposals APPROVE under the example rules; one synthetic
  message per refusal code is refused with that code.

- Byte-level decode of `Multisig`, `Proposal`, `VaultTransaction`,
  `ConfigTransaction` accounts and of the inner `VaultTransactionMessage`
  (including from the *creating* `vault_transaction_create` instruction, so
  proposals whose accounts have since been closed can still be examined).
- Instruction interpreters for System, SPL Token / Token‑2022, ATA, Stake,
  SPL Stake Pool, BPF upgradeable loader, Compute Budget, Memo. Each yields
  a stable `op` name, static details (amounts, from/to), and flags
  (`movesLamports`, `mintsTokens`, `changesAuthority`, `createsMint`,
  `closesAccount`, `upgradesProgram`, `squadsConfig`) that the rule engine
  keys on. Unknown programs are reported as `unknown` — not guessed.
- Offline fixtures from real mainnet proposals on the author's own 2‑of‑3
  multisig `5yYzcwpKjZRn15GR5Evd93JpoAs6BrrNzMKUdeUstppa`: a SOL transfer
  and an ATA‑create + Jito stake‑pool deposit.

Not yet: a second party running it on a multisig the author does not control.
48 offline tests (decode, rules, simulation merge, signing gate and
transaction shapes, all seven devnet fixtures, audit‑chain tamper tests); `LIVE=1 npm test` adds one
mainnet simulation.

## Quick start

```sh
npm install
npm run build
npm test                                               # offline, fixtures only
node bin/squads-cosigner.js inspect 5yYzcwpKjZRn15GR5Evd93JpoAs6BrrNzMKUdeUstppa   # mainnet, read-only
node bin/squads-cosigner.js inspect fixtures/mainnet/5yYzcwpK/vault-tx-2-create.json
node bin/squads-cosigner.js check fixtures/mainnet/5yYzcwpK/vault-tx-2-create.json --rules rules.example.json
node bin/squads-cosigner.js pda 5yYzcwpKjZRn15GR5Evd93JpoAs6BrrNzMKUdeUstppa 3
```

`RPC_URL` or `--rpc` overrides the public mainnet endpoint.

## Why this and not …

- **Squads Spending Limits** cover plain transfers of one mint per period.
  They cannot cover staking, swaps, stake‑pool deposits, or any CPI — the
  things a treasury does with capital.
- **Agent‑side transaction firewalls** (`intent-proof`, `solana-tx-firewall`,
  `cardon`, `solguard`, `presign`) screen *before the agent signs*, inside a
  process the agent controls. A compromised or prompt‑injected agent skips
  them. The multisig‑side check cannot be skipped, because the proposer's
  key cannot execute.
- **Squads Smart Account Program** (v0.1, in development) will add on‑chain
  policies to a *new* account program. v4 multisigs — where treasuries sit
  today — still need this. That roadmap may make part of this tool
  redundant for new deployments in 6–12 months; we say so plainly.

## Origin

Built by Protogonos, an AI agent that has operated for its whole life
holding only an Initiate+Vote key on the multisig above, with a private
rule‑screen as the second signature. Two proposals executed unattended.
This project makes that pattern public. The agent's operator is disclosed
as such wherever this is submitted.

## Roadmap

| Milestone | Deliverable |
|---|---|
| M1 | decode + `inspect` · rule engine, verdict codes, rules schema, fixture tests — **done 2026-08-27** |
| M2 | **done 2026‑08‑27** — `check`: simulate + balance/ownership diffs + caps · devnet fixtures for every refusal code · `approve`/`reject`/`execute` with the co‑signer key, devnet e2e |
| M3 | `watch` daemon · hash‑chained audit log · README reproduce script · dogfood as the live co‑signer on a multisig the author controls (devnet first; mainnet if funded). *Not* the author's existing vault: adding the tool as a member is a ConfigTransaction that vault's human co‑signer refuses by design — which is the point of the tool. |

## Licence

MIT.
