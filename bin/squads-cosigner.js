#!/usr/bin/env node
// squads-cosigner CLI. Shipped: `inspect`, `check` (static + simulation), `pda` (read-only),
// and `approve|reject|execute` (sign with --key, gated on an in-process re-check). `watch` lands in M3.
const fs = require("fs");
const path = require("path");

function usage(code) {
  console.error(`usage:
  squads-cosigner inspect <multisig|proposal|transaction pubkey> [--rpc URL] [--recent N]
  squads-cosigner inspect <fixture.json>       # offline decode of a saved fixture
  squads-cosigner check <proposal|fixture.json> --rules rules.json [--static] [--payer KEY]
                                               # rule verdict (exit 0 = APPROVE); simulates unless --static
  squads-cosigner pda <multisig> <index>       # derive transaction/proposal/vault PDAs
  squads-cosigner approve|reject|execute <proposal> --rules rules.json --key member.json [--dry-run] [--rpc URL]
                                               # re-runs check in-process; signs only if the rules permit
  squads-cosigner watch --rules rules.json --key member.json [--interval MS] [--rounds N] [--reject-refused] [--log audit.jsonl] [--rpc URL]
                                               # daemon: approve what the rules permit, execute when Approved, log a hash chain
  squads-cosigner verify-log <audit.jsonl>     # re-hash the audit chain

inspect/check/pda are read-only. approve/reject/execute sign with --key and
NEVER accept a verdict from the caller: the check is re-run before every signature.`);
  process.exit(code);
}

function loadLib() {
  const dist = path.join(__dirname, "..", "dist", "index.js");
  if (!fs.existsSync(dist)) {
    console.error("dist/ missing — run `npm run build` first");
    process.exit(1);
  }
  return require(dist);
}

function stringify(v) {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? Buffer.from(x).toString("base64") : x), 2);
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = {};
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) args.push(rest[i]);
    else if (rest[i + 1] === undefined || rest[i + 1].startsWith("--")) flags[rest[i].slice(2)] = true;
    else flags[rest[i].slice(2)] = rest[++i];
  }
  const lib = loadLib();
  if (cmd === "inspect" && args[0]) {
    if (fs.existsSync(args[0])) {
      const fx = JSON.parse(fs.readFileSync(args[0], "utf8"));
      console.log(stringify(lib.inspectFixture(fx)));
      return;
    }
    const out = await lib.inspectAddress(args[0], { rpcUrl: flags.rpc || process.env.RPC_URL, recent: flags.recent ? Number(flags.recent) : undefined });
    console.log(stringify(out));
    return;
  }
  if (cmd === "check" && args[0]) {
    if (!flags.rules) {
      console.error("check needs --rules <file.json>");
      process.exit(2);
    }
    const rules = lib.validateRules(JSON.parse(fs.readFileSync(flags.rules, "utf8")));
    const rpcUrl = flags.rpc || process.env.RPC_URL;
    if (!flags.static) {
      // Default: resolve lookup tables, simulate the inner message, apply static + simulated rules.
      const isFixture = fs.existsSync(args[0]);
      const input = isFixture ? lib.decodeVaultTransactionCreateIx(Buffer.from(JSON.parse(fs.readFileSync(args[0], "utf8")).ixDataBase64, "base64")).innerMessageBytes : args[0];
      const out = await lib.checkWithSimulation(input, rules, { rpcUrl, feePayer: typeof flags.payer === "string" ? flags.payer : undefined });
      console.log(stringify({ ...(isFixture ? { fixture: args[0] } : {}), rules: flags.rules, ...out }));
      process.exit(out.verdict === "APPROVE" ? 0 : 3);
    }
    let target;
    let evaluation;
    if (fs.existsSync(args[0])) {
      const fx = JSON.parse(fs.readFileSync(args[0], "utf8"));
      const ix = lib.decodeVaultTransactionCreateIx(Buffer.from(fx.ixDataBase64, "base64"));
      target = { fixture: args[0], multisig: fx.multisig, transactionIndex: fx.transactionIndex };
      evaluation = lib.evaluateVaultMessage(ix.message, rules);
    } else {
      const out = await lib.inspectAddress(args[0], { rpcUrl: flags.rpc || process.env.RPC_URL });
      const tx = out.transaction;
      if (!tx) {
        console.log(stringify({ address: args[0], verdict: "REFUSED_UNSCREENABLE", reasons: [{ verdict: "REFUSED_UNSCREENABLE", rule: "fetch", instruction: null, detail: out.error || "no transaction account for this proposal (closed?)" }] }));
        process.exit(3);
      }
      target = { address: args[0], proposal: out.proposal ?? null };
      if (tx.kind === "VaultTransaction") evaluation = lib.evaluateVaultMessage(tx.message, rules);
      else if (tx.kind === "ConfigTransaction") evaluation = lib.evaluateConfigTransaction(tx, rules);
      else evaluation = { verdict: "REFUSED_UNSCREENABLE", reasons: [{ verdict: "REFUSED_UNSCREENABLE", rule: "kind", instruction: null, detail: `unsupported account kind ${tx.kind}` }], lamportsOut: "0", tokenOut: {} };
    }
    console.log(stringify({ ...target, rules: flags.rules, static: true, ...evaluation }));
    process.exit(evaluation.verdict === "APPROVE" ? 0 : 3);
  }
  if ((cmd === "approve" || cmd === "reject" || cmd === "execute") && args[0]) {
    if (!flags.rules || typeof flags.key !== "string") {
      console.error(`${cmd} needs --rules <file.json> and --key <secret.json>`);
      process.exit(2);
    }
    const rules = lib.validateRules(JSON.parse(fs.readFileSync(flags.rules, "utf8")));
    const key = lib.loadKeypair(flags.key);
    const out = await lib.cosign(cmd, args[0], rules, key, { rpcUrl: flags.rpc || process.env.RPC_URL, dryRun: !!flags["dry-run"], memo: typeof flags.memo === "string" ? flags.memo : undefined, simulationPayer: typeof flags.payer === "string" ? flags.payer : undefined });
    console.log(stringify(out));
    process.exit(out.error ? 3 : 0);
  }
  if (cmd === "watch") {
    if (!flags.rules || typeof flags.key !== "string") {
      console.error("watch needs --rules <file.json> and --key <secret.json>");
      process.exit(2);
    }
    const rules = lib.validateRules(JSON.parse(fs.readFileSync(flags.rules, "utf8")));
    const key = lib.loadKeypair(flags.key);
    const summary = await lib.watch(rules, key, {
      rpcUrl: flags.rpc || process.env.RPC_URL,
      multisig: typeof flags.multisig === "string" ? flags.multisig : undefined,
      intervalMs: flags.interval ? Number(flags.interval) : undefined,
      rounds: flags.rounds ? Number(flags.rounds) : undefined,
      rejectRefused: !!flags["reject-refused"],
      logFile: typeof flags.log === "string" ? flags.log : undefined,
      onEvent: (e) => console.error(JSON.stringify(e)),
    });
    console.log(stringify(summary));
    return;
  }
  if (cmd === "verify-log" && args[0]) {
    const r = lib.verifyAuditLog(args[0]);
    console.log(stringify(r));
    process.exit(r.ok ? 0 : 3);
  }
  if (cmd === "pda" && args.length === 2) {
    const { PublicKey } = require("@solana/web3.js");
    const p = lib.pdas(new PublicKey(args[0]), BigInt(args[1]));
    console.log(stringify({ transactionPda: p.transactionPda.toBase58(), proposalPda: p.proposalPda.toBase58(), vaultPda: p.vaultPda.toBase58() }));
    return;
  }
  usage(cmd ? 1 : 0);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
