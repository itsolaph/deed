import test from "node:test";
import assert from "node:assert/strict";
import { isHolder } from "../src/gate.ts";

test("isHolder: owner matches", () => {
  assert.equal(isHolder("outlivelab-owner.testnet", "outlivelab-owner.testnet"), true);
});

test("isHolder: different account", () => {
  assert.equal(isHolder("outlivelab-owner.testnet", "outlivelab-other.testnet"), false);
});

test("isHolder: null connected", () => {
  assert.equal(isHolder("outlivelab-owner.testnet", null), false);
});

test("isHolder: mixed case", () => {
  assert.equal(isHolder("OutliveLab-Owner.TestNet", "outlivelab-owner.testnet"), true);
});
