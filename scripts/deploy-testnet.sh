#!/usr/bin/env bash
# Deploys tUSDC and the deed to testnet. See scripts/deploy-testnet.mjs for details.
# Needs: npm install, scripts/build.sh, and the parent account key in ~/.near-credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/deploy-testnet.mjs "$@"
