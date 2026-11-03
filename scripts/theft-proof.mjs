#!/usr/bin/env node
// Unauthorized-actions check for the demo video (scene 4a): six actions that would move vault
// money without the owner, each rejected on testnet. The file name is historical; it shows the
// tested actions only and does not prove that no other path exists. Standalone: it never touches
// the demo run.
//
// It loads a vault's worker key (the key the hosted API server holds) and tries every way that
// key could move money out of the vault. NEAR rejects each attempt before or during execution.
// Then a stranger calls withdraw on-chain (fails with a tx hash you can open), and an old worker
// key from a deed that was sold tries to keep charging (the key no longer exists).
// Nothing here can succeed; if any attempt does succeed the script exits 1.
//
//   node scripts/theft-proof.mjs [--vault <id>] [--key-file <worker key json>]
//                                [--stranger <account>] [--old-vault <id> --old-key-file <json>]
//
// Keys are read from the near-cli legacy keychain and never printed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider } from "near-api-js";
import { ONE_YOCTO, TGAS, NEAR, RPC_URLS, actions, loadPrivateKey, newKeyPair, provider, send, txLink, view } from "./lib/near.mjs";

// Attempts go through one plain provider: the failover wrapper would log each expected rejection
// as a stack trace and hide the reason behind "Exceeded 1 providers".
const direct = new JsonRpcProvider({ url: RPC_URLS[0] });

const HOME = os.homedir();
const WORKERS = path.join(process.env.NEAR_CREDENTIALS_DIR || path.join(HOME, ".near-credentials"), "testnet", "workers");

const { values } = parseArgs({
  options: {
    vault: { type: "string", default: "relay-live.deed2.deedlab.testnet" },
    "key-file": { type: "string" },
    stranger: { type: "string", default: "deedlab-alice.testnet" },
    "old-vault": { type: "string", default: "relay-1102ripe.deed2.deedlab.testnet" },
    "old-key-file": { type: "string" },
    slow: { type: "string", default: "1200" },
  },
});
const VAULT = values.vault;
const KEY_FILE = values["key-file"] ?? path.join(WORKERS, `${VAULT}.live.json`);
const OLD_VAULT = values["old-vault"];
const OLD_KEY_FILE = values["old-key-file"] ?? path.join(WORKERS, `${OLD_VAULT}.worker-a.json`);
const PAUSE = Number(values.slow);

const c = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c("1"), dim = c("2"), red = c("31"), green = c("32"), orange = c("38;5;202");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = async (s = "") => { console.log(s); await sleep(PAUSE / 4); };
const tusdc = (micro) => `${(Number(micro) / 1e6).toFixed(2)} tUSDC`;

function readKey(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const key = j.private_key || j.secret_key;
  if (!key) throw new Error(`no private key in ${path.basename(file)}`);
  return { key, publicKey: j.public_key };
}

const WHY = {
  MethodNameMismatch: "this key may only call charge",
  DepositWithFunctionCall: "this key cannot attach money to a call",
  RequiresFullAccess: "only a full-access key may do this, and the vault has none",
  ReceiverMismatch: "this key only works on the vault contract",
  AccessKeyDoesNotExist: "the sale deleted this key",
  NotEnoughAllowance: "the key's gas budget is spent",
};

function reason(e) {
  const text = `${e?.name ?? ""} ${e?.constructor?.name ?? ""} ${e?.type ?? ""} ${e?.message ?? e}`;
  for (const [k, why] of Object.entries(WHY)) if (text.includes(k)) return `${k}, ${why}`;
  return String(e?.message ?? e).split("\n")[0].slice(0, 160);
}

let blocked = 0, total = 0;

/** Runs one attempt that must fail. Returns the on-chain tx hash when the chain executed it. */
async function attempt(title, how, fn) {
  total++;
  await say(`${orange(`▸ ${total}.`)} ${bold(title)}`);
  await say(dim(`   ${how}`));
  try {
    const r = await fn();
    if (r && r.success === false) {
      blocked++;
      const msg = JSON.stringify(r.failure ?? r.receiptFailures[0] ?? {}).match(/"(?:ExecutionError|Panic|FunctionCallError)?"?:?"?([^"]*only the deed owner[^"]*|Smart contract panicked[^"]*)"/)?.[1]
        ?? JSON.stringify(r.failure ?? r.receiptFailures[0]).slice(0, 140);
      await say(`   ${green("BLOCKED")} on-chain: ${msg}`);
      await say(dim(`   tx ${r.hash}  ${txLink(r.hash)}`));
      return r.hash;
    }
    await say(`   ${red("NOT BLOCKED")} ${JSON.stringify(r).slice(0, 200)}`);
    return null;
  } catch (e) {
    blocked++;
    await say(`   ${green("BLOCKED")} by the protocol before execution: ${bold(reason(e))}`);
    return null;
  } finally {
    await say();
    await sleep(PAUSE);
  }
}

async function main() {
  const worker = readKey(KEY_FILE);
  const info = await view(VAULT, "get_info", {});
  if (info.worker_key !== worker.publicKey) {
    throw new Error(`the key file does not hold the current worker key of ${VAULT}`);
  }
  const ak = await provider.viewAccessKey({ accountId: VAULT, publicKey: worker.publicKey });
  const perm = ak.permission?.FunctionCall ?? ak.permission?.functionCall ?? ak.permission;
  const ftBefore = await view(info.payment_token, "ft_balance_of", { account_id: VAULT });

  await say(bold(`Unauthorized actions against ${VAULT}, each tried on testnet`));
  await say(`owner ${info.owner_id}, owner epoch ${info.owner_epoch}`);
  await say(`withdrawable revenue ${bold(tusdc(info.revenue))}, vault token balance ${tusdc(ftBefore)}`);
  await say();
  await say(bold("The API server holds this key. What NEAR allows it to do:"));
  await say(`   key        ${worker.publicKey.slice(0, 16)}…`);
  await say(`   receiver   ${perm?.receiver_id ?? perm?.receiverId}`);
  await say(`   methods    ${JSON.stringify(perm?.method_names ?? perm?.methodNames)}`);
  await say(`   gas budget ${(Number(BigInt(String(perm?.allowance ?? 0))) / 1e24).toFixed(3)} NEAR, no deposits`);
  await say();
  await sleep(PAUSE);

  const w = new Account(VAULT, direct, worker.key);
  await attempt(
    "Worker key calls withdraw",
    `withdraw({ amount: ${info.revenue}, receiver_id: "${values.stranger}" }) signed by the worker key`,
    () => send(w, VAULT, [actions.functionCall("withdraw", { amount: String(info.revenue), receiver_id: values.stranger }, 100n * TGAS, 0n)]),
  );
  await attempt(
    "Worker key sends the vault's NEAR away",
    `Transfer 0.01 NEAR from ${VAULT} to ${values.stranger}`,
    () => w.signAndSendTransaction({ receiverId: values.stranger, actions: [actions.transfer(NEAR / 100n)], waitUntil: "FINAL", throwOnFailure: false }),
  );
  await attempt(
    "Worker key gives itself a full-access key",
    "AddKey(new key, FullAccess) on the vault account",
    () => w.signAndSendTransaction({ receiverId: VAULT, actions: [actions.addFullAccessKey(newKeyPair().getPublicKey())], waitUntil: "FINAL", throwOnFailure: false }),
  );
  await attempt(
    "Worker key calls the token contract directly",
    `ft_transfer of the vault's ${tusdc(ftBefore)} on ${info.payment_token}, signed by the worker key`,
    () => w.signAndSendTransaction({ receiverId: info.payment_token, actions: [actions.functionCall("ft_transfer", { receiver_id: values.stranger, amount: String(ftBefore) }, 30n * TGAS, 0n)], waitUntil: "FINAL", throwOnFailure: false }),
  );
  const strangerHash = await attempt(
    "A stranger calls withdraw",
    `${values.stranger} signs withdraw on the vault (the chain runs it, the contract refuses)`,
    () => send(new Account(values.stranger, direct, loadPrivateKey(values.stranger)), VAULT, [actions.functionCall("withdraw", { amount: String(info.revenue || "1"), receiver_id: values.stranger }, 100n * TGAS, ONE_YOCTO)]),
  );

  if (fs.existsSync(OLD_KEY_FILE)) {
    const old = readKey(OLD_KEY_FILE);
    const oldInfo = await view(OLD_VAULT, "get_info", {});
    if (oldInfo.worker_key !== old.publicKey) {
      const o = new Account(OLD_VAULT, direct, old.key);
      await attempt(
        "The previous owner's worker key, after the deed was sold",
        `${OLD_VAULT} changed hands (epoch ${oldInfo.owner_epoch}); its old server tries to charge`,
        () => o.signAndSendTransaction({ receiverId: OLD_VAULT, actions: [actions.functionCall("charge", { items: [] }, 50n * TGAS, 0n)], waitUntil: "FINAL", throwOnFailure: false }),
      );
    }
  }

  const after = await view(VAULT, "get_info", {});
  const ftAfter = await view(info.payment_token, "ft_balance_of", { account_id: VAULT });
  const fundsKept = BigInt(ftAfter) >= BigInt(ftBefore) && BigInt(after.revenue) >= BigInt(info.revenue);
  await say(bold(`${blocked} of ${total} unauthorized actions rejected on testnet.`));
  await say(`withdrawable revenue ${tusdc(info.revenue)} → ${tusdc(after.revenue)}, vault token balance ${tusdc(ftBefore)} → ${tusdc(ftAfter)}`);
  if (strangerHash) await say(dim(`proof: ${txLink(strangerHash)}`));
  await say(fundsKept ? green(bold("No funds moved. These are the tested actions only, not a proof that no other path exists.")) : red(bold("Funds moved, investigate.")));
  process.exit(blocked === total && fundsKept ? 0 : 1);
}

main().catch((e) => {
  console.error(red(`unauthorized-actions check: ${e.message ?? e}`));
  process.exit(2);
});
