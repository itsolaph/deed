import assert from 'node:assert/strict';
import test from 'node:test';
import * as deployments from '../lib/deployments.mjs';

test('factory rollover preserves full legacy evidence without assigning it to the new factory', () => {
  const data = { network: 'testnet', accounts: { outlive: 'old.testnet', seller: 'seller.testnet', vault: 'relay.old.testnet' }, code_hashes: { vault: { sha256_base58: 'old-hash' } }, links: { vault: 'old-vault' }, deploy: [{ hash: 'deploy-old' }], demo: { ok: true, vault: 'relay.old.testnet' }, demo_runs: [{ ok: true }], hostileSeller: { vault: 'hostile.old.testnet' }, washReject: { vault: 'wash.old.testnet' }, outliveKeys: { fullAccess: true }, superseded: [{ outlive: 'older.testnet' }] };
  assert.equal(typeof deployments.archiveCurrentDeployment, 'function');
  deployments.archiveCurrentDeployment(data, 'new.testnet', '2026-11-06T00:00:00Z');
  assert.equal(data.superseded.length, 2);
  const archived = data.superseded[1];
  assert.equal(archived.outlive, 'old.testnet');
  assert.equal(archived.demo.vault, 'relay.old.testnet');
  assert.equal(archived.hostileSeller.vault, 'hostile.old.testnet');
  assert.equal(archived.washReject.vault, 'wash.old.testnet');
  assert.equal(archived.code_hashes.vault.sha256_base58, 'old-hash');
  assert.equal(archived.outliveKeys.fullAccess, true);
  assert.equal(archived.superseded, undefined);
  for (const key of ['demo', 'demo_runs', 'hostileSeller', 'washReject', 'deploy', 'outliveKeys']) assert.equal(data[key], undefined);
  assert.equal(data.accounts.vault, undefined);
  assert.equal(data.accounts.seller, 'seller.testnet');
  assert.equal(data.links.vault, undefined);
  assert.equal(archived.accounts.vault, 'relay.old.testnet');
});

test('factory deploy refuses to silently replace the vault code of an initialized factory', () => {
  assert.equal(typeof deployments.assertFactoryVaultCompatible, 'function');
  assert.throws(() => deployments.assertFactoryVaultCompatible('old-hash', 'new-hash'), /new factory account/);
  assert.doesNotThrow(() => deployments.assertFactoryVaultCompatible('same-hash', 'same-hash'));
});

test('redeploying the same factory does not archive or erase its evidence', () => {
  const data = { accounts: { outlive: 'same.testnet' }, demo: { ok: true } };
  const before = structuredClone(data);
  assert.equal(typeof deployments.archiveCurrentDeployment, 'function');
  deployments.archiveCurrentDeployment(data, 'same.testnet');
  assert.deepEqual(data, before);
});
