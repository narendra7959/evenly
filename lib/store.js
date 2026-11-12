'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Where groups are saved. Each group is one JSON document, keyed by its code.
 *
 *  - With DATABASE_URL set: a Postgres table (use this on Render, where the
 *    free plan's disk is wiped on every restart).
 *  - Otherwise: a JSON file in ./data (fine on your own computer).
 */

function fileStore(dir) {
  const file = path.join(dir, 'groups.json');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read saved groups:', err.message);
  }

  // Writes run one at a time; each writes a temp file then swaps it in, so a crash never leaves half a file.
  let queue = Promise.resolve();
  function flush() {
    queue = queue.catch(() => {}).then(async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(file + '.tmp', JSON.stringify(data));
      await fs.promises.rename(file + '.tmp', file);
    });
    return queue;
  }

  return {
    kind: 'file',
    async get(code) {
      return data[code] ? JSON.parse(JSON.stringify(data[code])) : null;
    },
    async put(group) {
      data[group.code] = JSON.parse(JSON.stringify(group));
      await flush();
    },
  };
}

function pgStore(pool) {
  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS groups (
      code TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  ready.catch((err) => console.error('Could not prepare the database:', err.message));

  return {
    kind: 'postgres',
    async get(code) {
      await ready;
      const result = await pool.query('SELECT data FROM groups WHERE code = $1', [code]);
      if (!result.rows.length) return null;
      const data = result.rows[0].data;
      return typeof data === 'string' ? JSON.parse(data) : data;
    },
    async put(group) {
      await ready;
      await pool.query(
        `INSERT INTO groups (code, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [group.code, JSON.stringify(group)],
      );
    },
  };
}

function createStore(env = process.env) {
  if (env.DATABASE_URL) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL);
    return pgStore(new Pool({
      connectionString: env.DATABASE_URL,
      ssl: local ? false : { rejectUnauthorized: false },
      max: 5,
    }));
  }
  return fileStore(env.DATA_DIR || path.join(__dirname, '..', 'data'));
}

module.exports = { createStore, fileStore, pgStore };
