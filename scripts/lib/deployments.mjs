// Reads and writes deployments/testnet.json.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { baseEncode } from "near-api-js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEPLOYMENTS_FILE = path.join(ROOT, "deployments", "testnet.json");

export function wasmPath(name) {
  return path.join(ROOT, "contracts", "target", "near", name, `${name}.wasm`);
}

export function readWasm(name) {
  const file = wasmPath(name);
  if (!fs.existsSync(file)) throw new Error(`missing ${path.relative(ROOT, file)}; run scripts/build.sh first`);
  return fs.readFileSync(file);
}

export function codeHash(bytes) {
  const digest = crypto.createHash("sha256").update(bytes).digest();
  return { sha256_base58: baseEncode(digest), sha256_hex: digest.toString("hex"), size_bytes: bytes.length };
}

export function loadDeployments() {
  if (!fs.existsSync(DEPLOYMENTS_FILE)) return { network: "testnet" };
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"));
}

export function saveDeployments(data) {
  fs.mkdirSync(path.dirname(DEPLOYMENTS_FILE), { recursive: true });
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(data, null, 2) + "\n");
}
