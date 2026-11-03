#!/usr/bin/env node
// withdraw-xchain: the owner's cross-chain payout, dry only. Gets a NEAR Intents 1Click dry
// quote for sending vault revenue (USDC on NEAR) to an address on another chain and prints
// the exact vault call it would make. It never signs or sends anything.
//
//   node agents/dist/src/withdraw-xchain.js --vault relay.deed2.deedlab.testnet \
//     --to eth:usdc --recipient 0x... [--amount 10|all] [--refund-to <near account>]

import { parseArgs } from "node:util";
import { VaultViews, formatUnits, fromUnits } from "@deed/sdk";
import { NETWORK, clock, isMain, rpc, runMain, tokenMeta, writeJson } from "./common.js";
import { DRY_QUOTE_LABEL, dryQuote, fetchTokens, findAsset, payoutQuoteRequest } from "./oneclick.js";

export function withdrawCommand(opts: { vault: string; owner: string; amount: bigint; receiver: string; network: string }): string {
  const args = JSON.stringify({ amount: opts.amount.toString(), receiver_id: opts.receiver, memo: "1Click payout" });
  return (
    `near contract call-function as-transaction ${opts.vault} withdraw json-args '${args}' ` +
    `prepaid-gas '80.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${opts.owner} network-config ${opts.network} sign-with-legacy-keychain send`
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      vault: { type: "string" },
      to: { type: "string", default: "eth:usdc" },
      recipient: { type: "string" },
      amount: { type: "string", default: "all" },
      "refund-to": { type: "string" },
      out: { type: "string" },
    },
  });
  if (!values.vault || !values.recipient) throw new Error("usage: withdraw-xchain --vault <account> --recipient <address on the target chain> [--to eth:usdc] [--amount n|all]");
  const say = (line: string) => process.stdout.write(`${clock()} [withdraw-xchain] ${line}\n`);
  const r = rpc();
  const info = await new VaultViews(r, values.vault).info();
  const token = await tokenMeta(r, info.payment_token);
  const amount = values.amount === "all" ? BigInt(info.revenue) : fromUnits(values.amount!, token.decimals);
  if (amount <= 0n) throw new Error("nothing to withdraw");
  say(`vault ${values.vault} (owner ${info.owner_id}) holds ${formatUnits(info.revenue, token.decimals)} ${token.symbol} of withdrawable revenue`);

  const tokens = await fetchTokens();
  const dest = findAsset(tokens, values.to!);
  // Refunds of a failed swap go back to an account on NEAR; the owner's mainnet account in a real run.
  const refundTo = values["refund-to"] ?? info.owner_id.replace(/\.testnet$/, ".near");
  const req = payoutQuoteRequest({ destinationAsset: dest.assetId, amountIn: amount, recipient: values.recipient, refundTo });
  const q = await dryQuote(req);
  say(`NEAR Intents 1Click, ${DRY_QUOTE_LABEL}: would send ${q.quote.amountInFormatted} USDC on NEAR -> would receive ${q.quote.amountOutFormatted} ${dest.symbol} on ${dest.blockchain} at ${values.recipient}, about ${q.quote.timeEstimate} s`);
  say("a dry quote has no deposit address and nothing was sent. A real payout (not done by this project) would ask for the same quote with dry=false and withdraw to its deposit address:");
  const command = withdrawCommand({ vault: values.vault, owner: info.owner_id, amount, receiver: "<depositAddress from the non-dry quote>", network: NETWORK });
  say(command);
  say(`on testnet the vault holds ${token.symbol}, which 1Click does not know; on mainnet the vault would hold native USDC (${req.originAsset}).`);
  writeJson(values.out, { label: DRY_QUOTE_LABEL, request: req, quote: q.quote, command });
}

if (isMain(import.meta.url)) runMain("withdraw-xchain", main);
