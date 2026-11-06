import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Journal } from "../src/journal.js";

function fixture(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "outlive-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "worker.jsonl");
}

test("journal repairs a torn tail before appending new obligations", (t) => {
  const file = fixture(t);
  const first = { t: "floor" as const, customer: "alice.testnet", seq: 1 };
  const second = { t: "floor" as const, customer: "bob.testnet", seq: 2 };
  fs.writeFileSync(file, JSON.stringify(first) + '\n{"t":"accepted","id":');
  const journal = new Journal(file);
  assert.deepEqual(journal.load(), [first]);
  journal.append(second);
  journal.close();
  assert.deepEqual(new Journal(file).load(), [first, second]);
});

test("journal fails closed on a corrupt complete record instead of dropping accounting", (t) => {
  const file = fixture(t);
  const data = '{"t":"floor","customer":"alice.testnet","seq":1}\nBROKEN\n';
  fs.writeFileSync(file, data);
  assert.throws(() => new Journal(file).load(), /corrupt journal record/);
  assert.equal(fs.readFileSync(file, "utf8"), data);
});

test("journal preserves complete JSON without a trailing newline and multibyte records", (t) => {
  const file = fixture(t);
  const first = { t: "state" as const, id: "delivery-é", state: "pending" as const };
  const second = { t: "floor" as const, customer: "bob.testnet", seq: 2 };
  fs.writeFileSync(file, JSON.stringify(first));
  const journal = new Journal(file);
  assert.deepEqual(journal.load(), [first]);
  journal.append(second);
  journal.close();
  assert.deepEqual(new Journal(file).load(), [first, second]);
});

test("journal synchronizes accepted obligations before append returns", (t) => {
  const file = fixture(t);
  const realSync = fs.fsyncSync;
  let syncs = 0;
  t.mock.method(fs, "fsyncSync", (fd: number) => { syncs++; realSync(fd); });
  const journal = new Journal(file);
  journal.append({ t: "floor", customer: "alice.testnet", seq: 1 });
  journal.close();
  assert.equal(syncs, 1);
});
