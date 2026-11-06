#!/usr/bin/env node
// outlive-worker --vault <account> --network testnet --port <p>
//
// Reads everything from chain and refuses to start unless its key file holds the vault's
// registered worker key. The only local state is the queue journal in --data-dir.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Rpc, formatUnits, rpcUrlsFor, signerFromSecretKey } from "@outlive/sdk";
import { displayPath, keychainFile, readKeyFile } from "@outlive/sdk/node";
import { Authenticator } from "./auth.js";
import { createServer } from "./server.js";
import { RpcVaultChain } from "./vault-chain.js";
import { Worker } from "./worker.js";

const USAGE = `usage: outlive-worker --vault <account> --network testnet --port <p> [options]

  --key-file <path>       worker key (default: ~/.near-credentials/<network>/<vault>.json)
  --host <ip>             bind address (default 127.0.0.1)
  --public-url <url>      URL customers use for this worker (default http://<host>:<port>)
  --data-dir <dir>        queue journal directory (default .outlive-worker/<vault>)
  --allow-target <ip:port> allow ONE local target, for demos only (default: none)
  --wait-for-key <sec>    wait up to this long for the key to be registered on chain
  --charge-gas <tgas>     prepaid gas per charge transaction (default 30)
  --flush-ms <ms>         charge batch interval (default 4000)
  --watch-ms <ms>         key-change watch interval (default 3000)
  --no-handoff            do not hand pending deliveries to the next worker
  --pid-file <path>       write the process id here
`;

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      vault: { type: "string" },
      network: { type: "string", default: "testnet" },
      port: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      "key-file": { type: "string" },
      "public-url": { type: "string" },
      "data-dir": { type: "string" },
      "allow-target": { type: "string" },
      "wait-for-key": { type: "string", default: "0" },
      "charge-gas": { type: "string", default: "30" },
      "flush-ms": { type: "string", default: "4000" },
      "watch-ms": { type: "string", default: "3000" },
      "no-handoff": { type: "boolean", default: false },
      "pid-file": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.vault || !values.port) {
    process.stdout.write(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const vault = values.vault;
  const network = values.network!;
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("bad --port");
  const host = values.host!;
  const publicUrl = (values["public-url"] ?? `http://${host}:${port}`).replace(/\/+$/, "");
  const log = (line: string) => process.stdout.write(`${ts()} [worker ${port}] ${line}\n`);

  const keyFile = values["key-file"] ?? keychainFile(vault, network);
  const key = readKeyFile(keyFile);
  const signer = signerFromSecretKey(key.private_key);
  if (signer.publicKey !== key.public_key) throw new Error(`key file ${displayPath(keyFile)} is inconsistent`);
  log(`vault ${vault}, worker key ${signer.publicKey} from ${displayPath(keyFile)}`);

  if (values["allow-target"]) {
    log(`WARNING: --allow-target ${values["allow-target"]} lets this worker call one non-public address. Use for local demos only.`);
  }

  const rpc = new Rpc(process.env.NEAR_RPC_URLS ? process.env.NEAR_RPC_URLS.split(",") : rpcUrlsFor(network));
  const chain = new RpcVaultChain(vault, rpc, key.private_key, Number(values["charge-gas"]));
  const dataDir = values["data-dir"] ?? path.join(".outlive-worker", vault);
  const worker = new Worker({
    vault,
    network,
    chain,
    signer,
    journalFile: path.join(dataDir, `journal-${signer.publicKey.slice(8, 20)}.jsonl`),
    publicUrl,
    allowTarget: values["allow-target"],
    flushIntervalMs: Number(values["flush-ms"]),
    watchIntervalMs: Number(values["watch-ms"]),
    handoff: !values["no-handoff"],
    log,
    onRetired: () => {
      log("exiting after handover");
      server.close();
      setTimeout(() => process.exit(0), 200).unref();
    },
  });

  // Refuse to serve with a key the vault does not know (optionally wait for the rotation).
  // The vault state names the new worker in the set_worker transaction, but the access
  // key itself lands in a later promise receipt, so the permission check can lag a
  // block behind checkKey(); both belong inside the same retry loop.
  const waitUntil = Date.now() + Number(values["wait-for-key"]) * 1000;
  for (;;) {
    try {
      await worker.checkKey();
      const perm = await chain.keyPermission(vault, signer.publicKey);
      if (perm !== "function_call") throw new Error(`the worker key on ${vault} is ${perm ?? "missing"}, expected a function-call key`);
      break;
    } catch (e) {
      if (Date.now() >= waitUntil) throw e;
      log("waiting for the vault to register this worker key ...");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const allowance = await chain.workerAllowance(signer.publicKey);
  log(`worker key registered on chain; allowance left ${allowance === null ? "unlimited" : formatUnits(allowance, 24, 4) + " NEAR"}`);

  await worker.start();
  const info = await chain.info();
  log(`price ${info.price_per_call} per call in ${info.payment_token}; endpoint on chain ${info.endpoint}`);
  if (info.endpoint.replace(/\/+$/, "") !== publicUrl) log(`note: the endpoint on chain is not ${publicUrl}; customers will not find this worker until set_config`);

  const auth = new Authenticator(vault, chain);
  const server = createServer(worker, auth, log);
  server.listen(port, host, () => log(`listening on ${publicUrl}`));
  if (values["pid-file"]) fs.writeFileSync(values["pid-file"], String(process.pid));

  const shutdown = (signal: string) => {
    log(`${signal}: flushing charges and stopping`);
    worker
      .flushCharges()
      .catch(() => undefined)
      .finally(() => {
        worker.stop();
        server.close();
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  process.stderr.write(`outlive-worker: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
