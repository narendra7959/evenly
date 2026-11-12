(() => {
  'use strict';

  // ------------------------------------------------------------ basics

  const app = document.getElementById('app');
  const netBanner = document.getElementById('net');

  const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'JPY', 'CHF', 'CNY', 'THB', 'MYR', 'IDR', 'LKR', 'NPR'];

  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    share: '<path d="M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 002 2h10a2 2 0 002-2v-5"/>',
    users: '<path d="M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 19v-1a4 4 0 00-3-3.9M15.5 3.2a3.5 3.5 0 010 6.6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3zM9 8h6M9 12h6"/>',
  };

  function icon(name, size = 18) {
    const span = document.createElement('span');
    span.className = 'icon';
    // Static markup from the table above, never user input.
    span.innerHTML =
      `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
      `stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span;
  }

  /** Tiny element builder. All text goes through text nodes, so user input is never parsed as HTML. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, value);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch (e) { /* private mode: keep going */ }
    },
    json(key, fallback) {
      try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
    },
  };

  function toast(message) {
    const el = h('div', { class: 'toast', text: message });
    // An open dialog covers the rest of the page, so the message has to live inside it to be seen.
    const dialog = document.querySelector('dialog[open]');
    const box = dialog
      ? dialog.querySelector('.toasts') || dialog.appendChild(h('div', { class: 'toasts', role: 'status' }))
      : document.getElementById('toasts');
    box.append(el);
    setTimeout(() => el.remove(), 4200);
  }

  // ------------------------------------------------------------ money

  const formatters = {};
  /** 123456 minor units -> "₹1,234.56" */
  function money(minor, currency) {
    if (!formatters[currency]) {
      formatters[currency] = new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return formatters[currency].format(minor / 100);
  }

  /** "1,234.5" -> 123450 minor units, or null if it isn't a valid amount. */
  function parseMoney(text) {
    const cleaned = String(text).replace(/[,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    return Math.round(parseFloat(cleaned) * 100);
  }

  const plain = (minor) => (minor / 100).toFixed(2);

  // ------------------------------------------------------------ connection

  const socket = io();

  function send(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(15000).emit(event, payload || {}, (err, res) => {
        if (err) resolve({ error: 'No reply from the server. Check your connection and try again.' });
        else resolve(res || { ok: true });
      });
    });
  }

  let code = null;    // the open group's code
  let group = null;   // latest group state from the server
  let meId = null;    // which member this browser is
  let ui = null;      // DOM handles for the group view
  let everConnected = false;

  socket.on('connect', async () => {
    netBanner.hidden = true;
    if (everConnected && code) {
      const res = await send('group:open', { code });
      if (res.state) setState(res.state);
    }
    everConnected = true;
  });
  socket.on('disconnect', () => { netBanner.hidden = false; });
  socket.on('group:state', (next) => {
    if (next && next.code === code) setState(next);
  });

  // ------------------------------------------------------------ routing

  function route() {
    const match = location.pathname.match(/^\/g\/([A-Za-z0-9]{6,12})\/?$/);
    if (match) openGroup(match[1].toUpperCase());
    else showHome();
  }
  window.addEventListener('popstate', route);

  function leaveGroupView() {
    if (code) socket.emit('group:leave');
    if (ui) ui.dialog.remove();
    code = null;
    group = null;
    ui = null;
    document.title = 'Evenly — split bills, stay even';
  }

  function remember(groupCode, name) {
    const list = store.json('evenly:groups', []).filter((g) => g.code !== groupCode);
    list.unshift({ code: groupCode, name });
    store.set('evenly:groups', JSON.stringify(list.slice(0, 8)));
  }

  function forget(groupCode) {
    store.set('evenly:groups', JSON.stringify(store.json('evenly:groups', []).filter((g) => g.code !== groupCode)));
  }

  async function openGroup(groupCode) {
    leaveGroupView();
    app.replaceChildren(h('p', { class: 'loading', text: 'Opening the group…' }));
    const res = await send('group:open', { code: groupCode });
    if (res.gone) {
      forget(groupCode);
      return showMissing();
    }
    if (res.error || !res.state) return showMissing(res.error);
    enterGroup(res.state, store.get('evenly:me:' + groupCode));
  }

  function enterGroup(state, memberId) {
    code = state.code;
    meId = memberId;
    buildGroupView();
    setState(state);
    if (!me()) askWho();
  }

  // ------------------------------------------------------------ home

  function currencySelect(selected, id) {
    return h('select', { id }, CURRENCIES.map((c) => h('option', { value: c, selected: c === selected }, c)));
  }

  function showHome() {
    leaveGroupView();
    const name = h('input', { id: 'g-name', type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'Goa trip, Flat 4B, Friday dinner…', required: true });
    const who = h('input', { id: 'g-me', type: 'text', maxlength: '24', autocomplete: 'nickname', placeholder: 'Your name', value: store.get('evenly:name') || '', required: true });
    const currency = currencySelect(store.get('evenly:currency') || 'INR', 'g-currency');
    const submit = h('button', { class: 'btn btn-primary btn-big', type: 'submit' }, 'Create group');

    const form = h('form', {
      class: 'card create',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!name.value.trim()) return name.focus();
        if (!who.value.trim()) return who.focus();
        submit.disabled = true;
        submit.textContent = 'Creating…';
        store.set('evenly:name', who.value.trim());
        store.set('evenly:currency', currency.value);
        const res = await send('group:create', { name: name.value, me: who.value, currency: currency.value });
        if (res.error || !res.state) {
          submit.disabled = false;
          submit.textContent = 'Create group';
          return toast(res.error || 'Could not create the group.');
        }
        store.set('evenly:me:' + res.code, res.memberId);
        history.pushState({}, '', '/g/' + res.code);
        enterGroup(res.state, res.memberId);
      },
    },
    h('h2', { text: 'Start a group' }),
    h('label', { for: 'g-name', text: 'What is it for?' }),
    name,
    h('div', { class: 'two' },
      h('div', null, h('label', { for: 'g-me', text: 'Your name' }), who),
      h('div', null, h('label', { for: 'g-currency', text: 'Currency' }), currency)),
    submit);

    const codeInput = h('input', { type: 'text', maxlength: '12', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'Group code', 'aria-label': 'Group code', class: 'code-input' });
    const joinForm = h('form', {
      class: 'join-code',
      onsubmit: (e) => {
        e.preventDefault();
        const value = codeInput.value.trim().toUpperCase();
        if (!/^[A-Z0-9]{6,12}$/.test(value)) return toast('Enter the group code, like K7M2QX4P.');
        history.pushState({}, '', '/g/' + value);
        route();
      },
    }, codeInput, h('button', { class: 'btn', type: 'submit' }, 'Open'));

    const recent = store.json('evenly:groups', []);

    app.replaceChildren(h('div', { class: 'home' },
      h('div', { class: 'home-left' },
        h('section', { class: 'hero' },
          h('p', { class: 'eyebrow', text: 'Trips · dinners · flat bills' }),
          h('h1', null, 'Split the bill. ', h('em', { text: 'Stay even.' })),
          h('p', { text: 'Add what everyone paid. Evenly works out who owes whom, in the fewest payments. No sign-up.' })),
        h('ol', { class: 'steps' },
          h('li', null, h('strong', { text: 'Make a group' }), h('span', { text: 'Share the link with your friends.' })),
          h('li', null, h('strong', { text: 'Add expenses' }), h('span', { text: 'Who paid, how much, and for whom.' })),
          h('li', null, h('strong', { text: 'Settle up' }), h('span', { text: 'See exactly who pays whom.' }))),
        h('section', { class: 'card join-card' },
          h('h2', { text: 'Got a code?' }),
          joinForm)),
      h('div', { class: 'home-right' },
        form,
        recent.length
          ? h('section', { class: 'card recent' },
            h('h2', { text: 'Your groups' }),
            h('ul', null, recent.map((g) =>
              h('li', null, h('a', { href: '/g/' + g.code }, h('strong', { text: g.name }), h('span', { class: 'muted', text: g.code }))))))
          : null),
    ));
  }

  function showMissing(message) {
    leaveGroupView();
    app.replaceChildren(h('section', { class: 'card missing' },
      h('h1', { text: 'This group isn’t here' }),
      h('p', { class: 'muted', text: message || 'The code may be mistyped, or the group no longer exists.' }),
      h('a', { class: 'btn btn-primary btn-big', href: '/' }, 'Start a new group')));
  }

  // ------------------------------------------------------------ group view

  const me = () => group && group.members.find((m) => m.id === meId);
  const nameOf = (id) => (group.members.find((m) => m.id === id) || {}).name || 'Someone';
  const inviteUrl = () => `${location.origin}/g/${group.code}`;
  const base = (minor) => money(minor, group.currency);

  const AVATAR_COLOURS = ['#2dd4bf', '#8b7cff', '#f59e0b', '#60a5fa', '#f472b6', '#34d399', '#fb7185', '#a78bfa'];
  function avatar(id) {
    const index = Math.max(0, group.members.findIndex((m) => m.id === id));
    return h('span', {
      class: 'avatar', 'aria-hidden': 'true',
      style: `background:${AVATAR_COLOURS[index % AVATAR_COLOURS.length]}`,
      text: (nameOf(id)[0] || '?').toUpperCase(),
    });
  }

  function setState(next) {
    group = next;
    document.title = `${group.name} · Evenly`;
    remember(group.code, group.name);
    render();
  }

  function setTab(tab) {
    ui.root.dataset.tab = tab;
    ui.tabs.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
  }

  function buildGroupView() {
    const memberInput = h('input', { type: 'text', maxlength: '24', autocomplete: 'off', placeholder: 'Add a person…', 'aria-label': 'Add a person' });

    ui = {
      title: h('h1'),
      you: h('div', { class: 'you' }),
      members: h('ul', { class: 'members' }),
      count: h('span', { class: 'count' }),
      entries: h('ul', { class: 'entries' }),
      transfers: h('ul', { class: 'transfers' }),
      totals: h('dl', { class: 'totals' }),
      dialog: h('dialog', { class: 'dialog' }),
    };
    ui.dialog.addEventListener('click', (e) => {
      if (e.target === ui.dialog && !ui.dialog.dataset.locked) ui.dialog.close();
    });
    document.body.append(ui.dialog);

    ui.tabs = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Sections' },
      [['expenses', 'Expenses'], ['people', 'People'], ['settle', 'Settle up']].map(([key, label]) =>
        h('button', { type: 'button', role: 'tab', 'data-tab': key, onclick: () => setTab(key) }, label)));

    const people = h('aside', { class: 'panel p-people' },
      h('div', { class: 'title-row' },
        ui.title,
        h('button', { class: 'icon-btn', type: 'button', title: 'Rename group', 'aria-label': 'Rename group', onclick: openRenameGroup }, icon('edit', 16))),
      h('button', { class: 'btn btn-small', type: 'button', onclick: openInvite }, icon('users', 16), 'Invite friends'),
      ui.you,
      h('h2', { text: 'People' }),
      ui.members,
      h('form', {
        class: 'add',
        onsubmit: async (e) => {
          e.preventDefault();
          const name = memberInput.value.trim();
          if (!name) return;
          memberInput.value = '';
          const res = await send('member:add', { name });
          if (res.error) {
            toast(res.error);
            memberInput.value = name;
          }
          memberInput.focus();
        },
      }, memberInput, h('button', { class: 'btn', type: 'submit', 'aria-label': 'Add person' }, icon('plus', 18))));

    const expenses = h('section', { class: 'panel p-expenses' },
      h('div', { class: 'panel-head' },
        h('h2', null, 'Expenses ', ui.count),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openExpense(null) }, icon('plus', 18), 'Add expense')),
      ui.entries);

    const settle = h('aside', { class: 'panel p-settle' },
      h('h2', { text: 'Settle up' }),
      h('p', { class: 'muted', text: 'The fewest payments that make everyone even.' }),
      ui.transfers,
      ui.totals,
      h('button', { class: 'btn btn-wide', type: 'button', onclick: copySummary }, icon('copy', 16), 'Copy summary'));

    ui.root = h('div', { class: 'group' }, ui.tabs, people, expenses, settle);
    app.replaceChildren(ui.root);
    setTab('expenses');
  }

  function balanceLabel(amount) {
    if (amount > 0) return h('span', { class: 'bal good', text: `gets back ${base(amount)}` });
    if (amount < 0) return h('span', { class: 'bal bad', text: `owes ${base(-amount)}` });
    return h('span', { class: 'bal', text: 'settled' });
  }

  function render() {
    const { summary } = group;
    ui.title.textContent = group.name;

    // Your own position.
    const mine = me();
    if (!mine) {
      ui.you.className = 'you';
      ui.you.replaceChildren(
        h('p', { class: 'you-label', text: 'See your own balance' }),
        h('button', { class: 'btn btn-small', type: 'button', onclick: askWho }, 'Tell us who you are'));
    } else {
      const amount = summary.balances[mine.id] || 0;
      ui.you.className = 'you ' + (amount > 0 ? 'is-good' : amount < 0 ? 'is-bad' : '');
      ui.you.replaceChildren(
        h('p', { class: 'you-label', text: amount > 0 ? 'You get back' : amount < 0 ? 'You owe' : `Hi ${mine.name}` }),
        h('p', { class: 'you-amount', text: amount === 0 ? 'You’re all settled' : base(Math.abs(amount)) }));
    }

    ui.members.replaceChildren(...group.members.map((m) =>
      h('li', null,
        h('button', {
          type: 'button', class: 'member', onclick: () => openMember(m),
          'aria-label': `${m.name}: edit`,
        },
        avatar(m.id),
        h('span', { class: 'member-name' }, m.name, m.id === meId ? h('span', { class: 'tagline', text: ' you' }) : null),
        balanceLabel(summary.balances[m.id] || 0)))));

    // Expenses and payments, newest first.
    const expensesCount = group.entries.filter((e) => e.kind === 'expense').length;
    ui.count.textContent = expensesCount ? String(expensesCount) : '';
    const rows = group.entries.slice().reverse().map((entry) => {
      const date = new Date(entry.at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      if (entry.kind === 'payment') {
        return h('li', { class: 'entry is-payment' },
          h('span', { class: 'entry-icon' }, icon('check', 16)),
          h('div', { class: 'entry-main' },
            h('strong', { text: `${nameOf(entry.from)} paid ${nameOf(entry.to)}` }),
            h('span', { class: 'muted', text: `Payment · ${date}` })),
          h('span', { class: 'entry-amount', text: base(entry.amount) }),
          h('button', {
            class: 'icon-btn', type: 'button', title: 'Undo this payment', 'aria-label': 'Undo this payment',
            onclick: async () => {
              const res = await send('entry:remove', { id: entry.id });
              if (res.error) toast(res.error);
            },
          }, icon('x', 16)));
      }
      const people = entry.split.type === 'equal' ? entry.split.among.length : Object.keys(entry.split.shares).length;
      const foreign = entry.currency !== group.currency;
      return h('li', null, h('button', { type: 'button', class: 'entry', onclick: () => openExpense(entry) },
        h('span', { class: 'entry-icon' }, icon('receipt', 16)),
        h('div', { class: 'entry-main' },
          h('strong', { text: entry.desc }),
          h('span', { class: 'muted', text: `${nameOf(entry.paidBy)} paid · ${people === 1 ? 'for 1 person' : `split ${people} ways`} · ${date}` })),
        h('span', { class: 'entry-amount' },
          money(entry.amount, entry.currency),
          foreign ? h('small', { text: `≈ ${base(Math.round(entry.amount * entry.rate))}` }) : null)));
    });
    ui.entries.replaceChildren(...(rows.length ? rows : [
      h('li', { class: 'empty' },
        h('strong', { text: 'No expenses yet' }),
        h('span', { text: 'Add the first thing someone paid for.' })),
    ]));

    // The settle-up plan.
    ui.transfers.replaceChildren(...(summary.transfers.length
      ? summary.transfers.map((t) =>
        h('li', { class: 'transfer' + (t.from === meId || t.to === meId ? ' is-mine' : '') },
          h('div', { class: 'transfer-who' },
            avatar(t.from), h('strong', { text: nameOf(t.from) }),
            icon('arrow', 16),
            avatar(t.to), h('strong', { text: nameOf(t.to) })),
          h('div', { class: 'transfer-foot' },
            h('span', { class: 'transfer-amount', text: base(t.amount) }),
            h('button', {
              class: 'btn btn-small', type: 'button',
              onclick: async (e) => {
                e.currentTarget.disabled = true;
                const res = await send('payment:add', t);
                if (res.error) toast(res.error);
                else toast(`Recorded: ${nameOf(t.from)} paid ${nameOf(t.to)}.`);
              },
            }, icon('check', 14), 'Mark paid'))))
      : [h('li', { class: 'empty' },
        h('strong', { text: expensesCount ? 'Everyone is even' : 'Nothing to settle yet' }),
        h('span', { text: expensesCount ? 'No payments needed.' : 'Payments appear here once there are expenses.' }))]));

    ui.totals.replaceChildren(
      h('div', null, h('dt', { text: 'Total spent' }), h('dd', { text: base(summary.total) })),
      mine ? h('div', null, h('dt', { text: 'Your share' }), h('dd', { text: base(summary.share[mine.id] || 0) })) : null,
      mine ? h('div', null, h('dt', { text: 'You paid' }), h('dd', { text: base(summary.paid[mine.id] || 0) })) : null);
  }

  // ------------------------------------------------------------ dialogs

  function showDialog(content, { locked = false } = {}) {
    ui.dialog.replaceChildren(...[].concat(content));
    if (locked) ui.dialog.dataset.locked = '1';
    else delete ui.dialog.dataset.locked;
    if (!ui.dialog.open) ui.dialog.showModal();
  }

  const closeDialog = () => ui.dialog.close();
  const cancelButton = (label = 'Cancel') => h('button', { class: 'btn', type: 'button', onclick: closeDialog }, label);

  /** "Which of these people are you?" so the app can show your own balance. */
  function askWho() {
    const input = h('input', { type: 'text', maxlength: '24', autocomplete: 'nickname', placeholder: 'Your name', 'aria-label': 'Your name', value: store.get('evenly:name') || '' });
    const choose = (id) => {
      meId = id;
      store.set('evenly:me:' + group.code, id);
      closeDialog();
      render();
    };
    showDialog([
      h('h2', { text: 'Who are you?' }),
      h('p', { class: 'muted', text: `Pick your name in “${group.name}” to see what you owe or get back.` }),
      h('ul', { class: 'who' }, group.members.map((m) =>
        h('li', null, h('button', { type: 'button', class: 'member', onclick: () => choose(m.id) }, avatar(m.id), h('span', { class: 'member-name', text: m.name }))))),
      h('form', {
        class: 'add',
        onsubmit: async (e) => {
          e.preventDefault();
          const name = input.value.trim();
          if (!name) return input.focus();
          const res = await send('member:add', { name });
          if (res.error) return toast(res.error);
          store.set('evenly:name', name);
          choose(res.memberId);
        },
      }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'I’m new, add me')),
      cancelButton('Just looking'),
    ]);
  }

  function openRenameGroup() {
    const input = h('input', { id: 'rename', type: 'text', maxlength: '60', autocomplete: 'off', value: group.name, required: true });
    showDialog(h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return input.focus();
        const res = await send('group:rename', { name: input.value });
        if (res.error) return toast(res.error);
        closeDialog();
      },
    },
    h('h2', { text: 'Rename group' }),
    h('label', { for: 'rename', text: 'Group name' }),
    input,
    h('div', { class: 'row' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'), cancelButton())));
    input.select();
  }

  function openMember(member) {
    const input = h('input', { id: 'member-name', type: 'text', maxlength: '24', autocomplete: 'off', value: member.name, required: true });
    const isMe = member.id === meId;
    showDialog(h('form', {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (!input.value.trim()) return input.focus();
        const res = await send('member:rename', { id: member.id, name: input.value });
        if (res.error) return toast(res.error);
        closeDialog();
      },
    },
    h('h2', { text: member.name }),
    h('dl', { class: 'totals' },
      h('div', null, h('dt', { text: 'Paid' }), h('dd', { text: base(group.summary.paid[member.id] || 0) })),
      h('div', null, h('dt', { text: 'Share' }), h('dd', { text: base(group.summary.share[member.id] || 0) })),
      h('div', null, h('dt', { text: 'Balance' }), h('dd', null, balanceLabel(group.summary.balances[member.id] || 0)))),
    h('label', { for: 'member-name', text: 'Name' }),
    input,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
      isMe ? null : h('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          meId = member.id;
          store.set('evenly:me:' + group.code, member.id);
          closeDialog();
          render();
        },
      }, 'This is me'),
      h('button', {
        class: 'btn btn-danger', type: 'button',
        onclick: async () => {
          const res = await send('member:remove', { id: member.id });
          if (res.error) return toast(res.error);
          closeDialog();
        },
      }, 'Remove'),
      cancelButton('Close'))));
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      if (button) {
        const label = button.lastChild;
        const old = label.textContent;
        label.textContent = 'Copied';
        setTimeout(() => { label.textContent = old; }, 1600);
      } else {
        toast('Copied.');
      }
    } catch (e) {
      window.prompt('Copy this:', text);
    }
  }

  function openInvite() {
    const copy = h('button', { class: 'btn', type: 'button', onclick: () => copyText(inviteUrl(), copy) }, icon('link', 16), 'Copy link');
    const share = navigator.share
      ? h('button', {
        class: 'btn', type: 'button',
        onclick: () => navigator.share({ title: group.name, text: `Join “${group.name}” on Evenly to split the bills`, url: inviteUrl() }).catch(() => {}),
      }, icon('share', 16), 'Share')
      : null;
    showDialog([
      h('h2', { text: 'Invite friends' }),
      h('p', { class: 'muted', text: 'Anyone with the link can see and add expenses.' }),
      h('div', { class: 'share' },
        h('img', { class: 'qr', src: `/qr/${group.code}`, width: '128', height: '128', alt: 'QR code that opens this group' }),
        h('div', { class: 'share-text' },
          h('p', { class: 'share-code' }, 'Group code', h('strong', { text: group.code })),
          h('p', { class: 'share-url', text: inviteUrl().replace(/^https?:\/\//, '') }),
          h('div', { class: 'row' }, copy, share))),
      h('button', { class: 'btn btn-wide', type: 'button', onclick: closeDialog }, 'Done'),
    ]);
  }

  function copySummary() {
    const { summary } = group;
    const lines = [`${group.name}: settle up`];
    if (summary.transfers.length) {
      for (const t of summary.transfers) lines.push(`• ${nameOf(t.from)} pays ${nameOf(t.to)} ${base(t.amount)}`);
    } else {
      lines.push('Everyone is even. No payments needed.');
    }
    lines.push(`Total spent: ${base(summary.total)}`, inviteUrl());
    copyText(lines.join('\n'));
  }

  /** Add a new expense, or edit one (pass the entry). */
  function openExpense(entry) {
    if (!group.members.length) return;
    let type = entry ? entry.split.type : 'equal';
    const among = new Set(entry && entry.split.type === 'equal' ? entry.split.among : group.members.map((m) => m.id));

    const desc = h('input', { id: 'x-desc', type: 'text', maxlength: '80', autocomplete: 'off', placeholder: 'Dinner, taxi, groceries…', value: entry ? entry.desc : '', required: true });
    const amount = h('input', { id: 'x-amount', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', value: entry ? plain(entry.amount) : '', required: true });
    const currency = currencySelect(entry ? entry.currency : group.currency, 'x-currency');
    currency.setAttribute('aria-label', 'Currency');
    const rate = h('input', { id: 'x-rate', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'e.g. 85.50' });
    const rateLabel = h('label', { for: 'x-rate' });
    const rateRow = h('div', { class: 'field' }, rateLabel, rate);
    const defaultPayer = entry ? entry.paidBy : (me() ? meId : group.members[0].id);
    const paidBy = h('select', { id: 'x-paid' }, group.members.map((m) =>
      h('option', { value: m.id, selected: m.id === defaultPayer }, m.id === meId ? `${m.name} (you)` : m.name)));

    const hint = h('p', { class: 'split-hint', role: 'status' });
    const rows = group.members.map((m) => {
      const box = h('input', { type: 'checkbox', checked: among.has(m.id), id: 'x-in-' + m.id });
      const each = h('span', { class: 'muted each' });
      const exact = h('input', {
        type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', class: 'exact',
        'aria-label': `${m.name}'s share`,
        value: entry && entry.split.type === 'exact' && entry.split.shares[m.id] ? plain(entry.split.shares[m.id]) : '',
      });
      box.addEventListener('change', () => {
        if (box.checked) among.add(m.id);
        else among.delete(m.id);
        update();
      });
      exact.addEventListener('input', update);
      return { id: m.id, box, each, exact, el: h('li', null, h('label', { for: 'x-in-' + m.id }, box, avatar(m.id), h('span', { text: m.name })), each, exact) };
    });

    const equalBtn = h('button', { type: 'button', onclick: () => { type = 'equal'; update(); } }, 'Equally');
    const exactBtn = h('button', { type: 'button', onclick: () => { type = 'exact'; update(); } }, 'Exact amounts');

    function update() {
      const foreign = currency.value !== group.currency;
      rateRow.hidden = !foreign;
      rateLabel.textContent = `1 ${currency.value} = how many ${group.currency}?`;
      equalBtn.className = type === 'equal' ? 'is-on' : '';
      exactBtn.className = type === 'exact' ? 'is-on' : '';
      equalBtn.setAttribute('aria-pressed', String(type === 'equal'));
      exactBtn.setAttribute('aria-pressed', String(type === 'exact'));

      const total = parseMoney(amount.value);
      let assigned = 0;
      for (const row of rows) {
        row.box.hidden = type !== 'equal';
        row.each.hidden = type !== 'equal';
        row.exact.hidden = type !== 'exact';
        row.each.textContent = type === 'equal' && among.has(row.id) && total
          ? money(Math.round(total / among.size), currency.value)
          : '';
        assigned += parseMoney(row.exact.value) || 0;
      }

      hint.className = 'split-hint';
      if (type === 'equal') {
        hint.textContent = among.size ? `Split between ${among.size} ${among.size === 1 ? 'person' : 'people'}.` : 'Choose at least one person.';
        if (!among.size) hint.classList.add('is-bad');
      } else if (total == null) {
        hint.textContent = 'Enter the total first, then each person’s share.';
      } else if (assigned === total) {
        hint.textContent = 'The shares add up.';
        hint.classList.add('is-good');
      } else if (assigned < total) {
        hint.textContent = `${money(total - assigned, currency.value)} still to share out.`;
        hint.classList.add('is-bad');
      } else {
        hint.textContent = `${money(assigned - total, currency.value)} too much.`;
        hint.classList.add('is-bad');
      }
    }

    amount.addEventListener('input', update);
    currency.addEventListener('change', () => {
      if (currency.value !== group.currency && !rate.value) {
        const known = group.rates[currency.value];
        rate.value = known ? String(known) : '';
      }
      update();
    });
    if (entry && entry.currency !== group.currency) rate.value = String(entry.rate);

    const save = h('button', { class: 'btn btn-primary', type: 'submit' }, entry ? 'Save changes' : 'Add expense');

    const form = h('form', {
      class: 'form expense-form',
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        if (!desc.value.trim()) {
          toast('Say what the expense was for.');
          return desc.focus();
        }
        const total = parseMoney(amount.value);
        if (!total) {
          toast('Enter the amount, like 450 or 450.50.');
          return amount.focus();
        }
        const payload = { desc: desc.value, amount: total, currency: currency.value, paidBy: paidBy.value };
        if (entry) payload.id = entry.id;
        if (currency.value !== group.currency) {
          payload.rate = parseFloat(String(rate.value).replace(/,/g, ''));
          if (!(payload.rate > 0)) {
            toast(`Enter how many ${group.currency} one ${currency.value} is worth.`);
            return rate.focus();
          }
        }
        if (type === 'equal') {
          if (!among.size) return toast('Choose at least one person to split between.');
          payload.split = { type: 'equal', among: [...among] };
        } else {
          const shares = {};
          let assigned = 0;
          for (const row of rows) {
            if (!row.exact.value.trim()) continue;
            const value = parseMoney(row.exact.value);
            if (value == null) {
              toast('Shares must be amounts like 120 or 120.50.');
              return row.exact.focus();
            }
            shares[row.id] = value;
            assigned += value;
          }
          if (assigned !== total) return toast('The shares must add up to the total.');
          payload.split = { type: 'exact', shares };
        }

        save.disabled = true;
        const res = await send('expense:save', payload);
        save.disabled = false;
        if (res.error) return toast(res.error);
        closeDialog();
      },
    },
    h('h2', { text: entry ? 'Edit expense' : 'Add an expense' }),
    h('div', { class: 'field' }, h('label', { for: 'x-desc', text: 'What was it for?' }), desc),
    h('div', { class: 'two' },
      h('div', { class: 'field' }, h('label', { for: 'x-amount', text: 'Amount' }), h('div', { class: 'amount-row' }, amount, currency)),
      h('div', { class: 'field' }, h('label', { for: 'x-paid', text: 'Paid by' }), paidBy)),
    rateRow,
    h('div', { class: 'field' },
      h('div', { class: 'split-head' }, h('span', { class: 'label', text: 'Split' }), h('div', { class: 'seg' }, equalBtn, exactBtn)),
      h('ul', { class: 'split' }, rows.map((r) => r.el)),
      hint),
    h('div', { class: 'row' },
      save,
      entry ? h('button', {
        class: 'btn btn-danger', type: 'button',
        onclick: async () => {
          const res = await send('entry:remove', { id: entry.id });
          if (res.error) return toast(res.error);
          closeDialog();
        },
      }, 'Delete') : null,
      cancelButton()));

    update();
    showDialog(form);
    if (!entry) desc.focus();
  }

  // ------------------------------------------------------------ start

  route();
})();
