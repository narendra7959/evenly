'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileStore, pgStore } = require('../lib/store');

const sample = (code, name) => ({ code, name, currency: 'INR', members: [{ id: 'm1', name: 'Asha' }], entries: [], rates: {} });

async function behavesLikeAStore(store) {
  assert.equal(await store.get('NOPE'), null);
  await store.put(sample('ABC', 'Goa trip'));
  await store.put(sample('XYZ', 'Flat'));
  assert.equal((await store.get('ABC')).name, 'Goa trip');

  // Saving again replaces the group.
  await store.put({ ...sample('ABC', 'Goa 2026'), entries: [{ kind: 'payment', id: 'p', from: 'a', to: 'b', amount: 5 }] });
  const again = await store.get('ABC');
  assert.equal(again.name, 'Goa 2026');
  assert.equal(again.entries[0].amount, 5);
  assert.equal((await store.get('XYZ')).name, 'Flat');
}

test('file store saves groups and reads them back after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evenly-'));
  await behavesLikeAStore(fileStore(dir));
  // A fresh store over the same folder is what a restart looks like.
  assert.equal((await fileStore(dir).get('ABC')).name, 'Goa 2026');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('file store hands out copies, so unsaved edits do not leak in', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evenly-'));
  const store = fileStore(dir);
  await store.put(sample('ABC', 'Goa trip'));
  (await store.get('ABC')).name = 'changed but not saved';
  assert.equal((await store.get('ABC')).name, 'Goa trip');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('postgres store saves groups and reads them back', async () => {
  // pg-mem is an in-memory stand-in for Postgres, so this runs without a real database.
  const { newDb } = require('pg-mem');
  const { Pool } = newDb().adapters.createPg();
  const pool = new Pool();
  await behavesLikeAStore(pgStore(pool));
});
