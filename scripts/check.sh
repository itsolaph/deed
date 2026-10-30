#!/usr/bin/env bash
# Runs every test suite that exists and exits non-zero on any failure:
#   contract builds (wasm), contract unit tests, sandbox integration tests,
#   Node tests and the web build (once those parts exist).
#
# SKIP_SANDBOX=1 skips the sandbox integration tests (they need to download neard once).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step() { printf '\n== %s\n' "$*"; }

step "build contracts"
bash scripts/build.sh

step "contract unit tests"
(cd contracts && cargo test -p vault -p deed -p tusdc)

if [[ "${SKIP_SANDBOX:-0}" != "1" ]]; then
  step "sandbox integration tests (ports 7640-7699)"
  (cd contracts && cargo test -p deed-tests --test integration -- --test-threads 4)
fi

step "node script syntax"
for f in scripts/*.mjs scripts/lib/*.mjs; do
  node --check "$f"
done

for dir in worker sdk agents; do
  if [[ -f "$dir/package.json" ]]; then
    step "node tests: $dir"
    (cd "$dir" && npm test)
  fi
done

if [[ -f web/package.json ]]; then
  step "web build"
  (cd web && npm run build)
fi

step "all checks passed"
