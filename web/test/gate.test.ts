import test from "node:test";
import assert from "node:assert/strict";
import { isHolder } from "../src/gate.ts";

test("isHolder: owner matches", () => {
  assert.equal(isHolder("deedlab-owner.testnet", "deedlab-owner.testnet"), true);
});

test("isHolder: different account", () => {
  assert.equal(isHolder("deedlab-owner.testnet", "deedlab-other.testnet"), false);
});

test("isHolder: null connected", () => {
  assert.equal(isHolder("deedlab-owner.testnet", null), false);
});

test("isHolder: mixed case", () => {
  assert.equal(isHolder("DeedLab-Owner.TestNet", "deedlab-owner.testnet"), true);
});
