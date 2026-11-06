import test from "node:test";
import assert from "node:assert/strict";
import { isHolder } from "../src/gate.ts";

test("isHolder: owner matches", () => {
  assert.equal(isHolder("outlive-owner.testnet", "outlive-owner.testnet"), true);
});

test("isHolder: different account", () => {
  assert.equal(isHolder("outlive-owner.testnet", "outlive-other.testnet"), false);
});

test("isHolder: null connected", () => {
  assert.equal(isHolder("outlive-owner.testnet", null), false);
});

test("isHolder: mixed case", () => {
  assert.equal(isHolder("Outlive-Owner.TestNet", "outlive-owner.testnet"), true);
});
