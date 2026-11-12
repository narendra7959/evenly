'use strict';

/**
 * Money maths for a group. All amounts are whole numbers of minor units
 * (paise, cents), so nothing is ever lost to floating-point rounding.
 *
 * An expense:  { kind: 'expense', id, amount, currency, rate, paidBy, split }
 *   amount is in the expense's own currency; `rate` converts it to the
 *   group's currency (1 for expenses already in the group's currency).
 *   split is { type: 'equal', among: [memberId] }
 *         or { type: 'exact', shares: { memberId: amount } }
 * A payment:   { kind: 'payment', id, from, to, amount }  (group currency)
 */

/** An expense's total in the group's currency. */
function baseTotal(expense) {
  return Math.round(expense.amount * expense.rate);
}

/** Who owes how much of an expense, in the group's currency. Always adds up to baseTotal. */
function sharesOf(expense, memberOrder) {
  const total = baseTotal(expense);
  const out = {};

  if (expense.split.type === 'exact') {
    const ids = Object.keys(expense.split.shares).filter((id) => expense.split.shares[id] > 0);
    let sum = 0;
    let biggest = ids[0];
    for (const id of ids) {
      out[id] = Math.round(expense.split.shares[id] * expense.rate);
      sum += out[id];
      if (expense.split.shares[id] > expense.split.shares[biggest]) biggest = id;
    }
    // Currency conversion can leave a paisa or two over; the largest share absorbs it.
    out[biggest] += total - sum;
    return out;
  }

  const among = memberOrder.filter((id) => expense.split.among.includes(id));
  const each = Math.floor(total / among.length);
  let extra = total - each * among.length;
  // Leftover paise go to different people for different expenses, so nobody always pays the extra.
  let start = 0;
  for (const ch of String(expense.id)) start += ch.charCodeAt(0);
  for (let i = 0; i < among.length; i++) {
    const id = among[(start + i) % among.length];
    out[id] = each + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
  }
  return out;
}

/** Pairs off the biggest debtor with the biggest creditor until everyone is square. */
function greedy(people) {
  const byAmount = (a, b) => b.v - a.v || (a.id < b.id ? -1 : 1);
  const debtors = people.filter((p) => p.v < 0).map((p) => ({ id: p.id, v: -p.v })).sort(byAmount);
  const creditors = people.filter((p) => p.v > 0).map((p) => ({ id: p.id, v: p.v })).sort(byAmount);
  const transfers = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d].v, creditors[c].v);
    transfers.push({ from: debtors[d].id, to: creditors[c].id, amount });
    debtors[d].v -= amount;
    creditors[c].v -= amount;
    if (debtors[d].v === 0) d += 1;
    if (creditors[c].v === 0) c += 1;
  }
  return transfers;
}

/**
 * Splits people into as many sub-groups as possible whose balances each add
 * up to zero. A sub-group of k people can settle among themselves in k - 1
 * payments, so more sub-groups means fewer payments overall.
 * Checks every combination, which is fast for up to 16 people.
 */
function zeroSumGroups(people) {
  const n = people.length;
  const size = 1 << n;
  const sum = new Float64Array(size);
  const best = new Int8Array(size); // most zero-sum groups that fit inside this set of people
  const via = new Int8Array(size);  // who to remove to get there

  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    sum[mask] = sum[mask ^ low] + people[31 - Math.clz32(low)].v;
    let top = -1;
    let pick = 0;
    for (let i = 0; i < n; i++) {
      if (!(mask & (1 << i))) continue;
      const without = best[mask ^ (1 << i)];
      if (without > top) {
        top = without;
        pick = i;
      }
    }
    best[mask] = top + (sum[mask] === 0 ? 1 : 0);
    via[mask] = pick;
  }

  const groups = [];
  let current = [];
  let mask = size - 1;
  while (mask) {
    const i = via[mask];
    current.push(people[i]);
    mask ^= 1 << i;
    if (sum[mask] === 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * The payments that make everyone even, using as few payments as possible.
 * `balances` maps memberId -> amount (positive: is owed money, negative: owes).
 */
function settle(balances) {
  const people = Object.keys(balances)
    .filter((id) => balances[id] !== 0)
    .map((id) => ({ id, v: balances[id] }));
  if (!people.length) return [];
  const groups = people.length <= 16 ? zeroSumGroups(people) : [people];
  const transfers = [];
  for (const group of groups) transfers.push(...greedy(group));
  return transfers.sort((a, b) => b.amount - a.amount);
}

/** Everything the screens need: balances, who paid what, and the settle-up plan. */
function summarize(group) {
  const order = group.members.map((m) => m.id);
  const balances = {};
  const paid = {};
  const share = {};
  for (const id of order) {
    balances[id] = 0;
    paid[id] = 0;
    share[id] = 0;
  }
  let total = 0;

  for (const entry of group.entries) {
    if (entry.kind === 'payment') {
      balances[entry.from] += entry.amount;
      balances[entry.to] -= entry.amount;
      continue;
    }
    const amount = baseTotal(entry);
    total += amount;
    balances[entry.paidBy] += amount;
    paid[entry.paidBy] += amount;
    const shares = sharesOf(entry, order);
    for (const id of Object.keys(shares)) {
      balances[id] -= shares[id];
      share[id] += shares[id];
    }
  }

  return { total, balances, paid, share, transfers: settle(balances) };
}

module.exports = { baseTotal, sharesOf, settle, summarize };
