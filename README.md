# Evenly

A group bill splitter. Make a group for a trip, a dinner or a shared flat, add what everyone paid, and Evenly works out who owes whom in the fewest payments. Share the link or QR code; nobody needs an account.

## What it does

- **Groups by link.** Anyone with the link can see and add expenses. Changes appear live for everyone.
- **Expenses.** Who paid, how much, and who it was for. Split equally between any of the group, or by exact amounts.
- **Other currencies.** An expense can be in another currency with an exchange rate you type in. The rate is remembered for next time.
- **Settle up.** A list of payments that makes everyone even, using as few payments as possible. "Mark paid" records a payment.
- **Your balance.** Tell the group who you are once, and it shows what you owe or get back.

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```
npm install
npm start
```

Open http://localhost:3000. Groups are saved in `data/groups.json`.

Run the tests with `npm test`.

## Deploy to Render (free)

Render's free plan wipes the disk on every restart, so the app needs a database to keep groups.

1. **Get a free Postgres database.** Sign up at [neon.tech](https://neon.tech), create a project, and copy its connection string (it starts with `postgresql://`).
2. **Put this folder in a GitHub repository.**
3. **In Render, choose New → Blueprint** and pick the repository. Render reads `render.yaml` and asks for `DATABASE_URL`: paste the connection string.
4. When the deploy finishes, the app is live at `https://<name>.onrender.com`.

The app creates its own table the first time it starts. If `DATABASE_URL` is not set, the app still runs but groups are lost whenever Render restarts it.

On the free plan the server sleeps after 15 minutes without visitors, and the next visitor waits about a minute while it wakes up. Saved groups are not affected.

## How it is built

- `server.js`: Express serves the page; Socket.IO carries live updates. Every change is checked on the server, saved, then sent to everyone viewing the group.
- `lib/ledger.js`: the money maths. Amounts are whole paise/cents, so nothing is lost to rounding. The settle-up plan splits people into the largest number of sub-groups whose balances cancel out, which gives the fewest payments.
- `lib/store.js`: saves each group as one JSON document, in Postgres when `DATABASE_URL` is set, otherwise in a file.
- `public/`: the web page, in plain JavaScript with no build step.
- `test/`: tests for the maths, both kinds of storage, and end-to-end tests that run real clients against the server.

## Good to know

- There are no accounts. The group code in the link is the only key, so share it only with people you trust with the group.
- Exchange rates are typed in by hand; the app does not look them up.
