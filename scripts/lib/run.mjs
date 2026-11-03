// Shared plumbing for the testnet story scripts (wash-reject, hostile-seller): a run directory
// in demo-logs/, a log, recorded steps with explorer links, child processes that are always
// stopped, and agents run to completion. Keys never pass through here.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./deployments.mjs";
import { txLink } from "./near.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createRun(kind, slug) {
  const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}`;
  const logs = path.join(ROOT, "demo-logs", id);
  fs.mkdirSync(logs, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logs, `${kind}.log`));
  const children = new Map();
  const record = { run: id, slug, started_at: new Date().toISOString(), steps: [] };

  const say = (line) => {
    const text = `${new Date().toISOString().slice(11, 19)} [${kind}] ${line}`;
    console.log(text);
    logStream.write(text + "\n");
  };
  const banner = (title) => {
    say("");
    say(`=== ${title}`);
  };
  /** `expect` is "success" or "failure"; ok means the outcome was the expected one. */
  const step = (name, { tx = null, success = null, expect = "success", note = undefined } = {}) => {
    const ok = success === null ? true : expect === "success" ? success : !success;
    const entry = { step: name, expect, ok, ...(tx ? { tx, link: txLink(tx) } : {}), ...(note !== undefined ? { note } : {}) };
    record.steps.push(entry);
    say(`${ok ? "ok  " : "FAIL"} ${name}${tx ? `  ${txLink(tx)}` : ""}${note !== undefined ? `  (${note})` : ""}`);
    return entry;
  };

  /** Runs a compiled agent to completion with --out, mirrors its output, returns the JSON. */
  const agent = async (script, args, name, settleMs = 6000) => {
    await sleep(settleMs);
    const out = path.join(logs, `${name}.json`);
    const res = spawnSync(process.execPath, [path.join(ROOT, script), ...args, "--out", out], { cwd: ROOT, encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
    fs.writeFileSync(path.join(logs, `${name}.log`), (res.stdout || "") + (res.stderr || ""));
    for (const line of (res.stdout || "").trimEnd().split("\n")) if (line) say("  " + line);
    if (res.stderr?.trim()) say("  " + res.stderr.trim().split("\n").join("\n  "));
    return fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { success: false, error: res.stderr };
  };

  const start = (name, script, args) => {
    const fd = fs.openSync(path.join(logs, `${name}.log`), "a");
    const child = spawn(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, stdio: ["ignore", fd, fd], env: process.env });
    children.set(name, child);
    child.on("exit", (code, signal) => say(`${name} exited (${signal ?? `code ${code}`})`));
    say(`started ${name} (pid ${child.pid}), log demo-logs/${id}/${name}.log`);
    return child;
  };
  const alive = (name) => {
    const c = children.get(name);
    return !!c && c.exitCode === null && c.signalCode === null;
  };
  const stop = (name, signal = "SIGTERM") => {
    if (alive(name)) children.get(name).kill(signal);
  };
  const waitExit = (name, ms) => {
    const c = children.get(name);
    if (!c || !alive(name)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      c.on("exit", () => {
        clearTimeout(t);
        resolve(true);
      });
    });
  };
  const stopAll = async () => {
    for (const name of children.keys()) stop(name);
    for (const name of children.keys()) if (!(await waitExit(name, 10_000))) stop(name, "SIGKILL");
  };
  const logText = (name) => {
    const f = path.join(logs, `${name}.log`);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  };
  const close = () => logStream.end();
  return { id, logs, record, say, banner, step, agent, start, stop, waitExit, stopAll, alive, logText, close };
}

export async function waitHealth(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return res.json();
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`${url} did not come up`);
}

export function portsFree(ports) {
  for (const p of ports) {
    const res = spawnSync("fuser", [`${p}/tcp`], { encoding: "utf8" });
    if (res.status === 0 && res.stdout.trim()) throw new Error(`port ${p} is in use; stop that process first`);
  }
}

export function buildPackages() {
  const build = spawnSync("npx", ["tsc", "-b", "sdk", "worker", "agents"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}${build.stderr}`);
}

/** Retries a send on transient RPC errors (a send rejected before acceptance never lands). */
export async function retrySend(fn, say = () => {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (i >= 4 || !/429|too many requests|fetch failed|econnreset|timeout|503|exceeded \d+ providers|rate limit/i.test(msg)) throw e;
      say(`  transient RPC error (${msg.slice(0, 80)}); retry ${i} in ${5 * i}s`);
      await sleep(5000 * i);
    }
  }
}

/** MMDDHHMM, for default slugs. */
export function stamp() {
  return new Date().toISOString().slice(5, 16).replace(/\D/g, "");
}
