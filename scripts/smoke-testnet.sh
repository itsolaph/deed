#!/usr/bin/env bash
# Testnet smoke run of the contract story. See scripts/smoke-testnet.mjs for the steps.
# Each run mints a new outlive: set SMOKE_SLUG to an unused slug for a second run.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/smoke-testnet.mjs "$@"
