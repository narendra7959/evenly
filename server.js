'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { summarize } = require('./lib/ledger');
const { createStore } = require('./lib/store');

const PORT = process.env.PORT || 3000;
const LIMITS = { groupName: 60, name: 24, desc: 80, members: 30, entries: 1000, amount: 1e11, rate: 1e7 };
const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'CHF', 'CNY', 'THB', 'MYR', 'IDR', 'LKR', 'NPR'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)

const store = createStore();

/** Groups currently in memory: code -> Promise<group | null>. The store is the source of truth. */
const cache = new Map();

function loadGroup(code) {
  if (!cache.has(code)) {
    const loading = store.get(code).catch((err) => {
      cache.delete(code);
      throw err;
    });
    cache.set(code, loading);
    loading.then((group) => {
      if (!group) cache.delete(code);
    }).catch(() => {});
  }
  return cache.get(code);
}

// ---------------------------------------------------------------- helpers

function clean(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function randomId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('base64url');
}

async function makeCode() {
  for (;;) {
    const code = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    if (!(await store.get(code))) return code;
  }
}

function normaliseCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : '';
}

function isAmount(value) {
  return Number.isInteger(value) && value > 0 && value <= LIMITS.amount;
}

function stateOf(group) {
  return {
    code: group.code,
    name: group.name,
    currency: group.currency,
    members: group.members,
    entries: group.entries,
    rates: group.rates,
    summary: summarize(group),
  };
}

const room = (code) => `group:${code}`;

/** Is this member part of any expense or payment? */
function isInvolved(group, memberId) {
  return group.entries.some((e) => {
    if (e.kind === 'payment') return e.from === memberId || e.to === memberId;
    if (e.paidBy === memberId) return true;
    return e.split.type === 'equal' ? e.split.among.includes(memberId) : memberId in e.split.shares;
  });
}

/** Checks an expense sent by a browser. Returns { error } or { expense }. */
function readExpense(group, body) {
  const memberIds = group.members.map((m) => m.id);
  const desc = clean(body.desc, LIMITS.desc);
  if (!desc) return { error: 'Say what the expense was for.' };
  if (!isAmount(body.amount)) return { error: 'Enter an amount greater than zero.' };
  if (!CURRENCIES.includes(body.currency)) return { error: 'Choose a currency.' };

  let rate = 1;
  if (body.currency !== group.currency) {
    rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > LIMITS.rate) {
      return { error: `Enter how much 1 ${body.currency} is worth in ${group.currency}.` };
    }
    if (Math.round(body.amount * rate) < 1) return { error: 'That amount is too small after conversion.' };
  }
  if (!memberIds.includes(body.paidBy)) return { error: 'Choose who paid.' };

  const split = body.split && typeof body.split === 'object' ? body.split : {};
  let cleanSplit;
  if (split.type === 'exact') {
    const shares = {};
    let sum = 0;
    const given = split.shares && typeof split.shares === 'object' ? split.shares : {};
    for (const id of Object.keys(given)) {
      if (!memberIds.includes(id)) return { error: 'Someone in the split is not in this group.' };
      const value = given[id];
      if (!Number.isInteger(value) || value < 0) return { error: 'Each share must be zero or more.' };
      if (value > 0) {
        shares[id] = value;
        sum += value;
      }
    }
    if (sum !== body.amount) return { error: 'The shares must add up to the total.' };
    cleanSplit = { type: 'exact', shares };
  } else {
    const among = Array.isArray(split.among) ? [...new Set(split.among)] : [];
    if (!among.length) return { error: 'Choose at least one person to split between.' };
    if (!among.every((id) => memberIds.includes(id))) return { error: 'Someone in the split is not in this group.' };
    cleanSplit = { type: 'equal', among };
  }

  return {
    expense: {
      kind: 'expense',
      desc,
      amount: body.amount,
      currency: body.currency,
      rate,
      paidBy: body.paidBy,
      split: cleanSplit,
    },
  };
}

// ---------------------------------------------------------------- http

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

function baseUrl(req) {
  return (process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// QR code for a group's link. Only real groups get one.
app.get('/qr/:code', async (req, res) => {
  try {
    const code = normaliseCode(req.params.code);
    if (!(await loadGroup(code))) return res.status(404).type('text').send('No such group');
    const svg = await QRCode.toString(`${baseUrl(req)}/g/${code}`, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#10141b', light: '#ffffff' },
    });
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    res.status(500).type('text').send('Could not make the QR code');
  }
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '10m', index: false }));

// Link previews need absolute URLs, so the page is served with this site's address filled in.
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
function sendIndex(req, res) {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML.split('__BASE_URL__').join(baseUrl(req)));
}
app.get('/', sendIndex);
app.get('/g/:code', sendIndex);
app.use((req, res) => res.redirect('/'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 32 * 1024 });

// ---------------------------------------------------------------- sockets

/** Registers an event handler with rate limiting, input guarding and an ack reply. */
function handle(socket, event, handler) {
  socket.on(event, async (payload, ack) => {
    if (typeof payload === 'function') {
      ack = payload;
      payload = {};
    }
    const reply = typeof ack === 'function' ? ack : () => {};

    const now = Date.now();
    const bucket = socket.data.bucket || (socket.data.bucket = { start: now, count: 0 });
    if (now - bucket.start > 5000) {
      bucket.start = now;
      bucket.count = 0;
    }
    if (++bucket.count > 40) return reply({ error: 'Slow down a moment.' });

    try {
      const body = payload && typeof payload === 'object' ? payload : {};
      reply((await handler(body)) || { ok: true });
    } catch (err) {
      console.error(`Error in ${event}:`, err);
      reply({ error: 'Something went wrong and that was not saved. Try again.' });
    }
  });
}

const NOT_OPEN = { error: 'This group is not open any more. Refresh the page.' };

/**
 * Runs a change against the socket's group. `change` returns { error } to
 * refuse; otherwise the group is saved and everyone viewing it is updated.
 */
function change(socket, event, apply) {
  handle(socket, event, async (body) => {
    const code = socket.data.code;
    const group = code && (await loadGroup(code));
    if (!group) return NOT_OPEN;
    const result = apply(group, body) || {};
    if (result.error) return result;
    group.updatedAt = Date.now();
    try {
      await store.put(group);
    } catch (err) {
      cache.delete(code); // forget the unsaved change; the next read comes from the store
      throw err;
    }
    io.to(room(code)).emit('group:state', stateOf(group));
    return { ok: true, ...result };
  });
}

io.on('connection', (socket) => {
  handle(socket, 'group:create', async (body) => {
    const name = clean(body.name, LIMITS.groupName);
    const me = clean(body.me, LIMITS.name);
    if (!name) return { error: 'Give the group a name.' };
    if (!me) return { error: 'Enter your name.' };
    if (!CURRENCIES.includes(body.currency)) return { error: 'Choose a currency.' };
    socket.data.created = (socket.data.created || 0) + 1;
    if (socket.data.created > 10) return { error: 'You have made a lot of groups. Refresh to make more.' };

    const member = { id: randomId(), name: me };
    const group = {
      code: await makeCode(),
      name,
      currency: body.currency,
      members: [member],
      entries: [],
      rates: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.put(group);
    cache.set(group.code, Promise.resolve(group));

    if (socket.data.code) socket.leave(room(socket.data.code));
    socket.data.code = group.code;
    socket.join(room(group.code));
    return { ok: true, code: group.code, memberId: member.id, state: stateOf(group) };
  });

  handle(socket, 'group:open', async (body) => {
    const code = normaliseCode(body.code);
    const group = code && (await loadGroup(code));
    if (!group) return { error: 'That group does not exist.', gone: true };
    if (socket.data.code && socket.data.code !== code) socket.leave(room(socket.data.code));
    socket.data.code = code;
    socket.join(room(code));
    return { ok: true, state: stateOf(group) };
  });

  handle(socket, 'group:leave', () => {
    if (socket.data.code) socket.leave(room(socket.data.code));
    socket.data.code = null;
  });

  change(socket, 'group:rename', (group, body) => {
    const name = clean(body.name, LIMITS.groupName);
    if (!name) return { error: 'Give the group a name.' };
    group.name = name;
  });

  change(socket, 'member:add', (group, body) => {
    const name = clean(body.name, LIMITS.name);
    if (!name) return { error: 'Enter a name.' };
    if (group.members.length >= LIMITS.members) return { error: `A group can have ${LIMITS.members} people.` };
    if (group.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      return { error: `${name} is already in the group.` };
    }
    const member = { id: randomId(), name };
    group.members.push(member);
    return { memberId: member.id };
  });

  change(socket, 'member:rename', (group, body) => {
    const member = group.members.find((m) => m.id === body.id);
    if (!member) return { error: 'That person is not in the group.' };
    const name = clean(body.name, LIMITS.name);
    if (!name) return { error: 'Enter a name.' };
    if (group.members.some((m) => m !== member && m.name.toLowerCase() === name.toLowerCase())) {
      return { error: `${name} is already in the group.` };
    }
    member.name = name;
  });

  change(socket, 'member:remove', (group, body) => {
    const member = group.members.find((m) => m.id === body.id);
    if (!member) return {};
    if (isInvolved(group, member.id)) {
      return { error: `${member.name} is part of an expense or payment, so they can't be removed.` };
    }
    if (group.members.length === 1) return { error: 'A group needs at least one person.' };
    group.members = group.members.filter((m) => m !== member);
  });

  change(socket, 'expense:save', (group, body) => {
    const { error, expense } = readExpense(group, body);
    if (error) return { error };

    if (body.id) {
      const index = group.entries.findIndex((e) => e.id === body.id && e.kind === 'expense');
      if (index === -1) return { error: 'That expense was deleted by someone else.' };
      group.entries[index] = { ...expense, id: body.id, at: group.entries[index].at };
    } else {
      if (group.entries.length >= LIMITS.entries) return { error: 'This group is full. Start a new one.' };
      group.entries.push({ ...expense, id: randomId(), at: Date.now() });
    }
    if (expense.currency !== group.currency) group.rates[expense.currency] = expense.rate;
  });

  change(socket, 'payment:add', (group, body) => {
    const ids = group.members.map((m) => m.id);
    if (!ids.includes(body.from) || !ids.includes(body.to) || body.from === body.to) {
      return { error: 'Choose who paid and who received.' };
    }
    if (!isAmount(body.amount)) return { error: 'Enter an amount greater than zero.' };
    if (group.entries.length >= LIMITS.entries) return { error: 'This group is full. Start a new one.' };
    group.entries.push({ kind: 'payment', id: randomId(), from: body.from, to: body.to, amount: body.amount, at: Date.now() });
  });

  change(socket, 'entry:remove', (group, body) => {
    group.entries = group.entries.filter((e) => e.id !== body.id);
  });
});

// Drop groups nobody is viewing from memory. They stay saved in the store.
setInterval(() => {
  for (const code of cache.keys()) {
    const viewers = io.sockets.adapter.rooms.get(room(code));
    if (!viewers || viewers.size === 0) cache.delete(code);
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Evenly is running on http://localhost:${PORT} (saving to ${store.kind})`);
    if (store.kind === 'file' && process.env.RENDER) {
      console.warn('No DATABASE_URL is set: groups are saved to a file that Render wipes on every restart.');
    }
  });
}

module.exports = { server, io, CURRENCIES };
