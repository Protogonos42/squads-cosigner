#!/usr/bin/env bash
# Reproduce the devnet end-to-end run from nothing: fresh keys → airdrop →
# 2-of-3 multisig with one proposal per verdict code → check each → run the
# daemon unattended for two rounds → verify the audit chain.
#
# usage: KEYS=/tmp/sc-keys scripts/reproduce.sh
# env:   RPC_URL (default https://api.devnet.solana.com)
#        AIRDROP_RPCS (space-separated list tried in order for requestAirdrop)
#        FUND_FROM    (optional: a funded devnet keyfile to transfer from when every faucet is rate-limited)
# Needs: node ≥18, `npm ci && npm run build` already done. Nothing here touches mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."
KEYS="${KEYS:-/tmp/squads-cosigner-keys}"
RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
AIRDROP_RPCS="${AIRDROP_RPCS:-https://solana-devnet.g.alchemy.com/v2/demo $RPC_URL}"
OUT="$KEYS/fixtures"            # fixtures for THIS run; the repo's fixtures/devnet is left alone
export KEYS RPC_URL OUT
mkdir -p "$KEYS"; chmod 700 "$KEYS"
[ -f dist/index.js ] || npm run build

# 1. keys (64-byte JSON arrays, same format as solana-keygen)
for n in proposer tool third; do
  [ -f "$KEYS/$n.json" ] || node -e '
    const {Keypair}=require("@solana/web3.js");
    require("fs").writeFileSync(process.argv[1], JSON.stringify(Array.from(Keypair.generate().secretKey)), {mode:0o600});' "$KEYS/$n.json"
done
PROPOSER=$(node -e 'const {Keypair}=require("@solana/web3.js");console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require("fs").readFileSync(process.argv[1])))).publicKey.toBase58())' "$KEYS/proposer.json")
TOOL=$(node -e 'const {Keypair}=require("@solana/web3.js");console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(require("fs").readFileSync(process.argv[1])))).publicKey.toBase58())' "$KEYS/tool.json")
echo "proposer $PROPOSER"; echo "tool     $TOOL"

# 2. airdrop: proposer needs ≥0.3 SOL (multisig rent + vault funding), tool ≥0.01 (its own tx fees)
airdrop() { # pubkey airdrop-lamports fallback-lamports
  for rpc in $AIRDROP_RPCS; do
    node -e '
      const {Connection,PublicKey}=require("@solana/web3.js");
      (async()=>{const c=new Connection(process.argv[1],"confirmed");
        const s=await c.requestAirdrop(new PublicKey(process.argv[2]),Number(process.argv[3]));
        const b=await c.getLatestBlockhash();await c.confirmTransaction({signature:s,...b},"confirmed");console.log("airdrop ok",s)})().catch(e=>{console.error("airdrop failed:",e.message.slice(0,120));process.exit(1)})' "$rpc" "$1" "$2" && return 0
  done
  if [ -n "${FUND_FROM:-}" ]; then   # fallback: transfer from an already-funded devnet key
    node -e '
      const fs=require("fs");const {Connection,Keypair,PublicKey,SystemProgram,Transaction}=require("@solana/web3.js");
      (async()=>{const c=new Connection(process.argv[1],"confirmed");
        const from=Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[2]))));
        const s=await c.sendTransaction(new Transaction().add(SystemProgram.transfer({fromPubkey:from.publicKey,toPubkey:new PublicKey(process.argv[3]),lamports:Number(process.argv[4])})),[from]);
        const b=await c.getLatestBlockhash();await c.confirmTransaction({signature:s,...b},"confirmed");console.log("funded from",from.publicKey.toBase58(),s)})()' "$RPC_URL" "$FUND_FROM" "$1" "${3:-$2}" && return 0
  fi
  echo "all airdrop RPCs refused; fund $1 by hand (https://faucet.solana.com), or set FUND_FROM=<funded devnet keyfile>, and rerun"; return 1
}
bal() { node -e 'const {Connection,PublicKey}=require("@solana/web3.js");new Connection(process.argv[1]).getBalance(new PublicKey(process.argv[2])).then(b=>console.log(b))' "$RPC_URL" "$1"; }
NEED=300000000; [ -f "$OUT/multisig.json" ] && NEED=20000000   # multisig already created on a previous run: fees only
[ "$(bal "$PROPOSER")" -ge "$NEED" ] || airdrop "$PROPOSER" 1000000000 $((NEED + 50000000))
[ "$(bal "$TOOL")" -ge 10000000 ] || airdrop "$TOOL" 100000000 20000000

# 3. multisig + one proposal per verdict code (idempotent)
node scripts/devnet-setup.js

# 4. read-only verdicts for every proposal
node -e '
  const s=require(process.env.OUT+"/multisig.json");
  for (const [k,v] of Object.entries(s.proposals)) console.log(k, v.proposalPda, v.expectedVerdict);' | while read -r name proposal expected; do
  got=$( (node bin/squads-cosigner.js check "$proposal" --rules "$OUT/rules.json" --rpc "$RPC_URL" 2>/dev/null || true) | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).verdict)}catch{console.log("(no verdict)")}})')
  printf '%-26s expected %-22s got %s\n' "$name" "$expected" "$got"
done

# 5. the daemon, unattended, two rounds; then verify the chain
LOG="$OUT/audit.jsonl"
node bin/squads-cosigner.js watch --rules "$OUT/rules.json" --key "$KEYS/tool.json" --rpc "$RPC_URL" --interval 12000 --rounds 2 --log "$LOG"
node bin/squads-cosigner.js verify-log "$LOG"
echo "done. audit log: $LOG"
