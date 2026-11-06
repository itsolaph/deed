#!/usr/bin/env bash
# Builds the contract wasm files in dependency order. The outlive embeds the vault wasm,
# so the vault must be built first.
#
# Output: contracts/target/near/{vault,outlive,tusdc}/<name>.wasm
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/contracts"

for crate in vault outlive tusdc; do
  echo "== building $crate"
  (cd "$crate" && cargo near build non-reproducible-wasm --no-abi)
done

for crate in vault outlive tusdc; do
  wasm="target/near/$crate/$crate.wasm"
  printf '%-6s %8d bytes  sha256 %s\n' "$crate" "$(wc -c < "$wasm")" "$(sha256sum "$wasm" | cut -d' ' -f1)"
done
