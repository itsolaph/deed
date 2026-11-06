// Loads KEY=value lines from `.env` in the repository root into process.env, without
// overriding variables that are already set. `.env` is git-ignored; see `.env.example`.
// Only plain settings belong there (accounts, ports, RPC URLs), never keys.

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./deployments.mjs";

export function loadEnv(file = process.env.OUTLIVE_ENV_FILE || path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return [];
  const set = [];
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = value.replace(/^(['"])(.*)\1$/, "$2");
    set.push(key);
  }
  return set;
}

loadEnv();
