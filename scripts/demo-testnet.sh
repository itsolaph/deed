#!/usr/bin/env bash
# The whole Deed story on testnet with explorer links at every step. See scripts/demo-testnet.mjs.
# Each run mints a new deed (slug relay-<MMDDHHMM> unless DEMO_SLUG is set) and costs the
# seller about 2.9 testnet NEAR. Takes about 6 minutes. Stops every process it started.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d node_modules ]] || npm ci
exec node scripts/demo-testnet.mjs "$@"
