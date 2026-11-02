#!/usr/bin/env node
// Records a vault's transactions from FastNEAR's transaction index as an SDK test fixture,
// trimmed to the fields sdk/src/history.ts reads.
//
//   node scripts/record-history-fixture.mjs relay-1102ripe.deed2.deedlab.testnet
//
// Writes sdk/test/fixtures/<vault>.json. Read only; 1 + ceil(n / 20) requests.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const vault = process.argv[2];
const api = process.argv[3] ?? "https://tx.test.fastnear.com";
if (!vault) {
  console.error("usage: record-history-fixture.mjs <vault account> [tx api base url]");
  process.exit(2);
}

async function post(path, body) {
  const res = await fetch(`${api}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path} answered HTTP ${res.status}`);
  return res.json();
}

const trimStatus = (s) => {
  if ("SuccessValue" in s) return { SuccessValue: "" };
  if ("SuccessReceiptId" in s) return { SuccessReceiptId: s.SuccessReceiptId };
  if ("Failure" in s) return { Failure: JSON.stringify(s.Failure).slice(0, 200) };
  return s;
};

const list = await post("/v0/account", { account_id: vault, max_block_height: null });
const accountTxs = list.account_txs.map((t) => ({
  transaction_hash: t.transaction_hash,
  tx_block_height: t.tx_block_height,
  tx_block_timestamp: t.tx_block_timestamp,
}));
const hashes = accountTxs.map((t) => t.transaction_hash);
const transactions = [];
for (let i = 0; i < hashes.length; i += 20) {
  const r = await post("/v0/transactions", { tx_hashes: hashes.slice(i, i + 20) });
  for (const tx of r.transactions) {
    transactions.push({
      transaction: { hash: tx.transaction.hash, signer_id: tx.transaction.signer_id, receiver_id: tx.transaction.receiver_id },
      receipts: tx.receipts.map((rc) => ({
        receipt: { receipt_id: rc.receipt.receipt_id, receiver_id: rc.receipt.receiver_id, predecessor_id: rc.receipt.predecessor_id },
        execution_outcome: {
          block_height: rc.execution_outcome.block_height,
          block_timestamp: String(rc.execution_outcome.block_timestamp),
          index: rc.execution_outcome.index,
          id: rc.execution_outcome.id,
          outcome: {
            logs: rc.execution_outcome.outcome.logs,
            executor_id: rc.execution_outcome.outcome.executor_id,
            status: trimStatus(rc.execution_outcome.outcome.status),
          },
        },
      })),
    });
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "sdk", "test", "fixtures", `${vault}.json`);
mkdirSync(dirname(out), { recursive: true });
const fixture = { vault, source: api, recorded_at: new Date().toISOString(), account: { account_txs: accountTxs, txs_count: list.txs_count }, transactions };
writeFileSync(out, JSON.stringify(fixture, null, 1) + "\n");
console.log(`${out}: ${accountTxs.length} listed, ${transactions.length} transactions`);
