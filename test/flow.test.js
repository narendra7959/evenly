'use strict';

// End-to-end tests: start the real server (saving to a temp folder) and drive it with real socket clients.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'evenly-flow-'));
process.env.DATA_DIR = DATA_DIR;
delete process.env.DATABASE_URL;

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../server');
const { fileStore } = require('../lib/store');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

test.after(() => {
  io.close();
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

function client(t) {
  const socket = connect(base, { transports: ['websocket'], forceNew: true });
  let latest = null;
  socket.on('group:state', (state) => { latest = state; });
  t.after(() => socket.close());
  return {
    socket,
    state: () => latest,
    send: (event, payload) => socket.timeout(3000).emitWithAck(event, payload || {}),
    async until(check) {
      for (let i = 0; i < 100; i++) {
        if (latest && check(latest)) return latest;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Timed out waiting for group state');
    },
  };
}

/** A group with Asha (creator), Ben and Chitra; a second client is viewing it. */
async function trip(t) {
  const asha = client(t);
  const viewer = client(t);
  const created = await asha.send('group:create', { name: 'Goa trip', me: 'Asha', currency: 'INR' });
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-Z0-9]{8}$/);
  const ben = (await asha.send('member:add', { name: 'Ben' })).memberId;
  const chitra = (await asha.send('member:add', { name: 'Chitra' })).memberId;
  assert.equal((await viewer.send('group:open', { code: created.code })).ok, true);
  return { asha, viewer, code: created.code, ids: { asha: created.memberId, ben, chitra } };
}

test('pages and QR codes are served', async (t) => {
  const { code } = await trip(t);
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Evenly/);
  assert.ok(!html.includes('__BASE_URL__'));
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(`${base}/g/${code}`)).status, 200);
  const qr = await fetch(`${base}/qr/${code}`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /svg/);
  assert.equal((await fetch(`${base}/qr/ZZZZZZZZ`)).status, 404);
});

test('an expense updates everyone\'s balances live, and paying settles them', async (t) => {
  const { asha, viewer, ids } = await trip(t);
  const all = [ids.asha, ids.ben, ids.chitra];

  // Asha pays 900.00 for dinner, split three ways.
  assert.equal((await asha.send('expense:save', {
    desc: 'Dinner', amount: 90000, currency: 'INR', paidBy: ids.asha, split: { type: 'equal', among: all },
  })).ok, true);

  const state = await viewer.until((s) => s.entries.length === 1);
  assert.equal(state.summary.total, 90000);
  assert.equal(state.summary.balances[ids.asha], 60000);
  assert.equal(state.summary.balances[ids.ben], -30000);
  assert.equal(state.summary.transfers.length, 2);

  // Ben pays Asha back.
  await viewer.send('payment:add', { from: ids.ben, to: ids.asha, amount: 30000 });
  const paid = await asha.until((s) => s.entries.length === 2);
  assert.equal(paid.summary.balances[ids.ben], 0);
  assert.deepEqual(paid.summary.transfers, [{ from: ids.chitra, to: ids.asha, amount: 30000 }]);

  // Undo the payment.
  await asha.send('entry:remove', { id: paid.entries[1].id });
  const undone = await viewer.until((s) => s.entries.length === 1);
  assert.equal(undone.summary.balances[ids.ben], -30000);
});

test('expenses can be edited, use exact shares, and another currency', async (t) => {
  const { asha, viewer, ids } = await trip(t);

  await asha.send('expense:save', {
    desc: 'Taxi', amount: 60000, currency: 'INR', paidBy: ids.ben, split: { type: 'equal', among: [ids.asha, ids.ben] },
  });
  const first = await viewer.until((s) => s.entries.length === 1);

  // Edit: it was actually 20 USD at 85, with exact shares 15 / 5.
  assert.equal((await asha.send('expense:save', {
    id: first.entries[0].id, desc: 'Airport taxi', amount: 2000, currency: 'USD', rate: 85,
    paidBy: ids.ben, split: { type: 'exact', shares: { [ids.asha]: 1500, [ids.ben]: 500, [ids.chitra]: 0 } },
  })).ok, true);

  const edited = await viewer.until((s) => s.entries[0].desc === 'Airport taxi');
  assert.equal(edited.entries.length, 1);
  assert.equal(edited.summary.total, 170000);
  assert.equal(edited.summary.balances[ids.asha], -127500);
  assert.equal(edited.summary.balances[ids.ben], 127500);
  assert.equal(edited.summary.balances[ids.chitra], 0);
  assert.equal(edited.rates.USD, 85, 'the rate is remembered for next time');
});

test('bad expenses are refused', async (t) => {
  const { asha, ids } = await trip(t);
  const good = { desc: 'Lunch', amount: 5000, currency: 'INR', paidBy: ids.asha, split: { type: 'equal', among: [ids.asha, ids.ben] } };
  const bad = async (over) => (await asha.send('expense:save', { ...good, ...over })).error;

  assert.match(await bad({ desc: '   ' }), /what the expense/);
  assert.match(await bad({ amount: 0 }), /greater than zero/);
  assert.match(await bad({ amount: 12.5 }), /greater than zero/);
  assert.match(await bad({ currency: 'XXX' }), /currency/);
  assert.match(await bad({ currency: 'USD' }), /worth/);
  assert.match(await bad({ paidBy: 'stranger' }), /who paid/);
  assert.match(await bad({ split: { type: 'equal', among: [] } }), /at least one/);
  assert.match(await bad({ split: { type: 'equal', among: ['stranger'] } }), /not in this group/);
  assert.match(await bad({ split: { type: 'exact', shares: { [ids.asha]: 100 } } }), /add up/);
  assert.match((await asha.send('payment:add', { from: ids.asha, to: ids.asha, amount: 100 })).error, /who paid/);
  assert.equal(asha.state().entries.length, 0, 'refused changes are not saved');
});

test('people: no duplicates, rename works, and people with expenses cannot be removed', async (t) => {
  const { asha, viewer, ids } = await trip(t);
  assert.match((await asha.send('member:add', { name: 'ben' })).error, /already/);
  await asha.send('member:rename', { id: ids.ben, name: 'Benjamin' });
  await viewer.until((s) => s.members.some((m) => m.name === 'Benjamin'));

  await asha.send('expense:save', {
    desc: 'Tea', amount: 1000, currency: 'INR', paidBy: ids.asha, split: { type: 'equal', among: [ids.asha, ids.ben] },
  });
  assert.match((await asha.send('member:remove', { id: ids.ben })).error, /can't be removed/);
  assert.equal((await asha.send('member:remove', { id: ids.chitra })).ok, true);
  const state = await viewer.until((s) => s.members.length === 2);
  assert.deepEqual(state.members.map((m) => m.name), ['Asha', 'Benjamin']);
});

test('groups are saved, so they are still there after a restart', async (t) => {
  const { asha, code, ids } = await trip(t);
  await asha.send('expense:save', {
    desc: 'Hotel', amount: 300000, currency: 'INR', paidBy: ids.chitra, split: { type: 'equal', among: [ids.asha, ids.ben, ids.chitra] },
  });
  await asha.send('group:rename', { name: 'Goa 2026' });

  // Reading the saved file directly is what a restarted server would see.
  const saved = await fileStore(DATA_DIR).get(code);
  assert.equal(saved.name, 'Goa 2026');
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].desc, 'Hotel');
  assert.equal(saved.members.length, 3);
});

test('unknown groups are reported as gone, and changes need an open group', async (t) => {
  const stranger = client(t);
  assert.equal((await stranger.send('group:open', { code: 'NOPE2222' })).gone, true);
  assert.match((await stranger.send('member:add', { name: 'X' })).error, /not open/);
});
