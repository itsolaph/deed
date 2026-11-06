#!/usr/bin/env bash
# Hostile seller on testnet: the seller kills its worker with SIGKILL after the sale, before any
# hand-off, while customers have jobs in flight. See scripts/hostile-seller.mjs for what is checked.
# Mints a new outlive (slug hostile-<MMDDHHMM> unless HOSTILE_SLUG is set): the seller needs about
# 3.5 testnet NEAR. Takes about 20 minutes (10 are the vault's refund delay). Stops every process
# it started.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d node_modules ]] || npm ci
exec node scripts/hostile-seller.mjs "$@"
