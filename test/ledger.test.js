'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sharesOf, settle, summarize } = require('../lib/ledger');

const members = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase() }));
const order = members.map((m) => m.id);
const expense = (over) => ({ kind: 'expense', id: 'e1', amount: 0, currency: 'INR', rate: 1, paidBy: 'a', split: { type: 'equal', among: order }, ...over });
const sum = (obj) => Object.values(obj).reduce((n, v) => n + v, 0);

/** Applies the suggested payments and returns what is still owed. */
function afterPaying(balances, transfers) {
  const left = { ...balances };
  for (const t of transfers) {
    assert.ok(t.amount > 0);
    left[t.from] += t.amount;
    left[t.to] -= t.amount;
  }
  return left;
}

test('equal split shares the leftover paise and always adds up', () => {
  const shares = sharesOf(expense({ amount: 1000, split: { type: 'equal', among: ['a', 'b', 'c'] } }), order);
  assert.equal(sum(shares), 1000);
  assert.deepEqual(Object.values(shares).sort(), [333, 333, 334]);
});

test('exact split converts each share and still adds up to the converted total', () => {
  // 10.01 USD at 83.337 = 834.20 INR (rounded), split 3.34 / 3.34 / 3.33
  const e = expense({ amount: 1001, currency: 'USD', rate: 83.337, split: { type: 'exact', shares: { a: 334, b: 334, c: 333 } } });
  const shares = sharesOf(e, order);
  assert.equal(sum(shares), Math.round(1001 * 83.337));
});

test('balances: the payer is owed everyone else\'s share', () => {
  const { balances, total, paid, share } = summarize({
    members,
    entries: [expense({ amount: 40000 })],
  });
  assert.equal(total, 40000);
  assert.deepEqual(balances, { a: 30000, b: -10000, c: -10000, d: -10000 });
  assert.equal(paid.a, 40000);
  assert.equal(share.b, 10000);
  assert.equal(sum(balances), 0);
});

test('a recorded payment reduces what is owed', () => {
  const { balances, transfers } = summarize({
    members,
    entries: [
      expense({ amount: 40000 }),
      { kind: 'payment', id: 'p1', from: 'b', to: 'a', amount: 10000 },
    ],
  });
  assert.equal(balances.b, 0);
  assert.equal(balances.a, 20000);
  assert.equal(transfers.length, 2);
  assert.ok(transfers.every((t) => t.to === 'a'));
});

test('settle: everyone ends at zero', () => {
  const balances = { a: 5000, b: -1200, c: -3300, d: -500 };
  const transfers = settle(balances);
  assert.deepEqual(afterPaying(balances, transfers), { a: 0, b: 0, c: 0, d: 0 });
  assert.equal(transfers.length, 3);
});

test('settle: finds the fewest payments by pairing off people who cancel out', () => {
  // Two independent pairs (a<-b 70, c<-d 30) plus e<-f,g. Greedy by size alone would
  // need more payments; pairing exact matches needs only 4.
  const balances = { a: 7000, b: -7000, c: 3000, d: -3000, e: 5000, f: -2000, g: -3000 };
  const transfers = settle(balances);
  assert.equal(transfers.length, 4);
  assert.ok(Object.values(afterPaying(balances, transfers)).every((v) => v === 0));
});

test('settle: a case where the simple biggest-first method is not the best', () => {
  // Biggest-first pays 8<-(-8)... here: creditors 6,5,3 and debtors 8,3,3.
  // Best: d2(3)->c3(3) leaves creditors 6,5 and debtors 8,3: 3 more payments = 4 total.
  const balances = { c1: 600, c2: 500, c3: 300, d1: -800, d2: -300, d3: -300 };
  const transfers = settle(balances);
  assert.ok(Object.values(afterPaying(balances, transfers)).every((v) => v === 0));
  assert.equal(transfers.length, 4);
});

test('settle: nothing to do when everyone is even', () => {
  assert.deepEqual(settle({ a: 0, b: 0 }), []);
});

test('settle: still balances for groups too big to check every combination', () => {
  const balances = {};
  let total = 0;
  for (let i = 0; i < 19; i++) {
    balances['m' + i] = (i % 2 ? -1 : 1) * (100 + i * 37);
    total += balances['m' + i];
  }
  balances.last = -total;
  const transfers = settle(balances);
  assert.ok(Object.values(afterPaying(balances, transfers)).every((v) => v === 0));
  assert.ok(transfers.length <= 19);
});

test('foreign-currency expenses are counted in the group currency', () => {
  const { total, balances } = summarize({
    members,
    entries: [expense({ amount: 2000, currency: 'USD', rate: 85, paidBy: 'b', split: { type: 'equal', among: ['a', 'b'] } })],
  });
  assert.equal(total, 170000);
  assert.deepEqual(balances, { a: -85000, b: 85000, c: 0, d: 0 });
});
