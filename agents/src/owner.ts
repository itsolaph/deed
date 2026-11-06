#!/usr/bin/env node
// owner: the token holder's tool. Each command signs one transaction with the owner's key from
// the legacy keychain and prints the explorer link.
//
//   owner mint     --as <acc> --slug <s> --title <t> --price <tUSDC> --endpoint <url> --image-hash <h> [--daily-cap <tUSDC>]
//   owner keygen   --as <acc> --vault <v> [--key-file <path>]      new worker key (mode 600), not registered
//   owner rotate   --as <acc> --vault <v> --endpoint <url> [--key-file <path>] [--allowance <NEAR>]
//                  uses the key file if it exists, else generates one, and sends
//                  set_worker + set_config in ONE transaction
//   owner list     --as <acc> --token-id <id> --price <tUSDC>
//   owner cancel   --as <acc> --token-id <id>
//   owner withdraw --as <acc> --vault <v> [--amount <tUSDC>|all] [--receiver <acc>]
//   owner push-stats --as <acc> --vault <v>

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { OutliveViews, VaultViews, formatUnits, fromUnits, generateSecretKey, vaultAccountFor } from "@outlive/sdk";
import { credentialsDir, displayPath, readKeyFile, writeKeyFile, type TxOutcome } from "@outlive/sdk/node";
import { NETWORK, clock, isMain, loadDeployments, rpc, runMain, tokenMeta, txLink, txSigner, withRpcRetry, writeJson } from "./common.js";

const ONE_YOCTO = 1n;
const NEAR = 10n ** 24n;

function report(say: (l: string) => void, what: string, out: TxOutcome): void {
  say(`${what}: ${out.success ? "ok" : "FAILED"} ${txLink(out.hash)}${out.success ? "" : ` (${(out.error ?? "").slice(0, 300)})`}`);
}

/** Where `rotate` stores a new worker key: next to the keychain, never in the repo. */
export function workerKeyPath(vault: string, publicKey: string): string {
  return path.join(credentialsDir(), NETWORK, "workers", `${vault}.${publicKey.slice(8, 20)}.json`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      as: { type: "string" },
      outlive: { type: "string" },
      vault: { type: "string" },
      "token-id": { type: "string" },
      slug: { type: "string" },
      title: { type: "string" },
      price: { type: "string" },
      endpoint: { type: "string" },
      "image-hash": { type: "string" },
      "daily-cap": { type: "string", default: "100" },
      "key-file": { type: "string" },
      allowance: { type: "string", default: "2" },
      amount: { type: "string", default: "all" },
      receiver: { type: "string" },
      out: { type: "string" },
    },
  });
  if (!command || !values.as) throw new Error("usage: owner <mint|rotate|list|cancel|withdraw|push-stats> --as <account> ...");
  const dep = loadDeployments();
  const outliveId = values.outlive ?? dep.accounts.outlive;
  const r = rpc();
  const signer = txSigner(values.as);
  const send = <T,>(fn: () => Promise<T>): Promise<T> => withRpcRetry(fn, 4, (line) => say(`  ${line}`));
  const say = (line: string) => process.stdout.write(`${clock()} [owner ${values.as}] ${line}\n`);
  const outlive = new OutliveViews(r, outliveId);
  const config = await outlive.config();
  const token = await tokenMeta(r, config.payment_token);
  const units = (v: string) => fromUnits(v, token.decimals);
  let result: Record<string, unknown> = {};

  switch (command) {
    case "mint": {
      if (!values.slug || !values.price || !values.endpoint) throw new Error("mint needs --slug, --price and --endpoint");
      const cost = BigInt(await outlive.mintCost());
      const { slug, price, endpoint } = { slug: values.slug!, price: values.price!, endpoint: values.endpoint! };
      const out = await send(() => signer.call(outliveId, {
        method: "mint",
        args: {
          slug,
          title: values.title ?? slug,
          price_per_call: units(price).toString(),
          endpoint,
          image_hash: values["image-hash"] ?? "",
          default_daily_cap: units(values["daily-cap"]!).toString(),
        },
        gasTgas: 300,
        depositYocto: cost,
      }));
      report(say, `mint ${slug} (deposit ${formatUnits(cost, 24, 3)} NEAR, excess refunded)`, out);
      result = { tx: out.hash, success: out.success, vault: vaultAccountFor(outliveId, slug) };
      break;
    }
    case "rotate": {
      if (!values.vault || !values.endpoint) throw new Error("rotate needs --vault and --endpoint");
      const info = await new VaultViews(r, values.vault).info();
      // Use a key prepared with `keygen` (so the new worker can start first), or make one now.
      let key: { publicKey: string };
      let file: string;
      if (values["key-file"] && fs.existsSync(values["key-file"])) {
        file = values["key-file"];
        key = { publicKey: readKeyFile(file).public_key };
        say(`using worker key ${key.publicKey} from ${displayPath(file)}`);
      } else {
        const fresh = generateSecretKey();
        file = values["key-file"] ?? workerKeyPath(values.vault, fresh.publicKey);
        writeKeyFile(file, { account_id: values.vault, public_key: fresh.publicKey, private_key: fresh.secretKey });
        key = fresh;
        say(`new worker key ${key.publicKey} saved to ${displayPath(file)} (mode 600)`);
      }
      const allowance = (BigInt(Math.round(Number(values.allowance) * 1000)) * NEAR) / 1000n;
      const { vault, endpoint } = { vault: values.vault!, endpoint: values.endpoint! };
      // Key and endpoint in one transaction: customers never see the new endpoint without the key.
      const out = await send(() => signer.callMany(vault, [
        { method: "set_worker", args: { public_key: key.publicKey, allowance: allowance.toString() }, gasTgas: 60, depositYocto: ONE_YOCTO },
        { method: "set_config", args: { endpoint: values.endpoint, image_hash: info.image_hash }, gasTgas: 20, depositYocto: ONE_YOCTO },
      ]));
      report(say, `set_worker + set_config(endpoint ${endpoint}) in one transaction`, out);
      result = { tx: out.hash, success: out.success, public_key: key.publicKey, key_file: displayPath(file), previous_key: info.worker_key };
      break;
    }
    case "keygen": {
      if (!values.vault) throw new Error("keygen needs --vault");
      const fresh = generateSecretKey();
      const file = values["key-file"] ?? workerKeyPath(values.vault, fresh.publicKey);
      writeKeyFile(file, { account_id: values.vault, public_key: fresh.publicKey, private_key: fresh.secretKey });
      say(`worker key ${fresh.publicKey} saved to ${displayPath(file)} (mode 600); not registered yet, run rotate`);
      result = { public_key: fresh.publicKey, key_file: displayPath(file) };
      break;
    }
    case "list": {
      if (!values["token-id"] || !values.price) throw new Error("list needs --token-id and --price");
      const { token_id: listToken, price: listPrice } = { token_id: values["token-id"]!, price: values.price! };
      const out = await send(() => signer.call(outliveId, { method: "list", args: { token_id: listToken, price: units(listPrice).toString() }, gasTgas: 100, depositYocto: ONE_YOCTO }));
      report(say, `list ${values["token-id"]} for ${values.price} ${token.symbol}`, out);
      const d = await outlive.outliveOf(values["token-id"]);
      say(`listing ${d?.listing ? `#${d.listing.listing_id} active=${d.listing.active}` : "missing"}`);
      result = { tx: out.hash, success: out.success, listing: d?.listing ?? null };
      break;
    }
    case "cancel": {
      if (!values["token-id"]) throw new Error("cancel needs --token-id");
      const out = await send(() => signer.call(outliveId, { method: "cancel_listing", args: { token_id: values["token-id"] }, gasTgas: 100, depositYocto: ONE_YOCTO }));
      report(say, `cancel listing of ${values["token-id"]}`, out);
      result = { tx: out.hash, success: out.success };
      break;
    }
    case "withdraw": {
      if (!values.vault) throw new Error("withdraw needs --vault");
      const info = await new VaultViews(r, values.vault).info();
      const amount = values.amount === "all" ? BigInt(info.revenue) : units(values.amount!);
      say(`vault revenue ${formatUnits(info.revenue, token.decimals)} ${token.symbol}, owner on chain ${info.owner_id}, locked ${info.locked}; withdrawing ${formatUnits(amount, token.decimals)}`);
      const args: Record<string, unknown> = { amount: (amount > 0n ? amount : 1n).toString() };
      if (values.receiver) args.receiver_id = values.receiver;
      const out = await send(() => signer.call(values.vault!, { method: "withdraw", args, gasTgas: 80, depositYocto: ONE_YOCTO }));
      report(say, "withdraw", out);
      result = { tx: out.hash, success: out.success, amount: amount.toString(), error: out.error ?? null };
      break;
    }
    case "push-stats": {
      if (!values.vault) throw new Error("push-stats needs --vault");
      const out = await send(() => signer.call(values.vault!, { method: "push_stats", args: {}, gasTgas: 50, depositYocto: 0n }));
      report(say, "push_stats (refreshes the NFT certificate)", out);
      result = { tx: out.hash, success: out.success };
      break;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
  writeJson(values.out, { command, ...result, link: typeof result.tx === "string" ? txLink(result.tx) : null });
  if (result.success === false) process.exitCode = 1;
}

if (isMain(import.meta.url)) runMain("owner", main);
