'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Three storage back-ends, picked from the environment:
//   pg     — Postgres (Netlify Database / Neon, or any POSTGRES URL). Serverless-safe.
//   libsql — remote Turso/libSQL database.
//   file   — local SQLite file (development, and the default everywhere else).
const DB_URL = String(
  process.env.NETLIFY_DB_URL || process.env.DATABASE_URL || process.env.TURSO_DATABASE_URL || ''
).trim();

const MODE = /^postgres(ql)?:\/\//i.test(DB_URL)
  ? 'pg'
  : (DB_URL && !DB_URL.startsWith('file:') ? 'libsql' : 'file');

// ---------------------------------------------------------------- postgres ---

let pgPool = null;
if (MODE === 'pg') {
  const { Pool, types } = require('pg');
  // Postgres hands int8/numeric back as strings; the app has always treated
  // them as numbers (COUNT, SUM, ids), so parse them here once.
  types.setTypeParser(20, v => (v == null ? null : Number(v)));
  types.setTypeParser(1700, v => (v == null ? null : Number(v)));
  const ssl = /sslmode=require|neon\.tech|supabase|render\.com/i.test(DB_URL)
    ? { rejectUnauthorized: false }
    : undefined;
  pgPool = new Pool({
    connectionString: DB_URL,
    ssl,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pgPool.on('error', err => console.error('[db] idle pool error:', err.message));
}

// SQLite's datetime('now') becomes a UTC timestamp in the same "YYYY-MM-DD
// HH:MM:SS" text shape, so every lexicographic comparison in the app keeps
// working and timestamps render the way the views expect.
const NOW_SQL = "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')";

function toPg(sql) {
  let i = 0;
  let out = sql.replace(/\?/g, () => `$${++i}`);
  out = out.replace(/datetime\(\s*'now'\s*\)/gi, NOW_SQL);
  return out;
}

// Tables whose primary key is a generated integer. An INSERT into one of them
// gets "RETURNING id" so run() can report lastInsertRowid like SQLite did.
const ID_TABLES = new Set(['users', 'orders', 'deposits', 'stars_payments']);

function wantsId(sql) {
  if (/\breturning\b/i.test(sql)) return false;
  const m = sql.match(/^\s*insert\s+into\s+([a-z_][a-z0-9_]*)/i);
  return Boolean(m) && ID_TABLES.has(m[1].toLowerCase());
}

function pgResult(res, addId) {
  return {
    changes: Number(res.rowCount || 0),
    lastInsertRowid: addId && res.rows[0] ? Number(res.rows[0].id) : 0,
  };
}

// ------------------------------------------------------------------ libsql ---

let client = null;
if (MODE === 'libsql') {
  const { createClient } = require('@libsql/client');
  client = createClient({ url: DB_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
} else if (MODE === 'file') {
  const { createClient } = require('@libsql/client');
  // Serverless has a read-only project FS — fall back to /tmp so a missing
  // database URL degrades into a fresh ephemeral DB, not a crash.
  const ephemeral = process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME;
  const DATA_DIR = process.env.DATA_DIR || (ephemeral ? '/tmp/data' : path.join(__dirname, '..', 'data'));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  client = createClient({ url: 'file:' + path.join(DATA_DIR, 'app.db') });
}

// ------------------------------------------------------------------- query ---

function plain(row) {
  return row ? Object.assign({}, row) : row;
}

async function all(sql, ...args) {
  if (MODE === 'pg') {
    const res = await pgPool.query(toPg(sql), args);
    return res.rows.map(plain);
  }
  const res = await client.execute({ sql, args });
  return res.rows.map(plain);
}

async function get(sql, ...args) {
  const rows = await all(sql, ...args);
  return rows[0] || null;
}

async function run(sql, ...args) {
  if (MODE === 'pg') {
    const addId = wantsId(sql);
    const res = await pgPool.query(toPg(sql) + (addId ? ' RETURNING id' : ''), args);
    return pgResult(res, addId);
  }
  const res = await client.execute({ sql, args });
  return {
    changes: Number(res.rowsAffected || 0),
    lastInsertRowid: res.lastInsertRowid != null ? Number(res.lastInsertRowid) : 0,
  };
}

// Execute several statements as one write transaction.
async function batch(statements) {
  if (!statements.length) return [];
  const norm = statements.map(s =>
    typeof s === 'string' ? { sql: s, args: [] } : { sql: s.sql, args: s.args || [] }
  );

  if (MODE === 'pg') {
    const conn = await pgPool.connect();
    try {
      await conn.query('BEGIN');
      const out = [];
      for (const st of norm) {
        const addId = wantsId(st.sql);
        const res = await conn.query(toPg(st.sql) + (addId ? ' RETURNING id' : ''), st.args);
        out.push(pgResult(res, addId));
      }
      await conn.query('COMMIT');
      return out;
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  const out = [];
  for (let i = 0; i < norm.length; i += 400) {
    const chunk = norm.slice(i, i + 400);
    const res = await client.batch(chunk, 'write');
    out.push(...res);
  }
  return out;
}

// ------------------------------------------------------------------ schema ---

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS services (
    service_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    type TEXT,
    rate REAL NOT NULL,
    min INTEGER NOT NULL DEFAULT 1,
    max INTEGER NOT NULL DEFAULT 1000000,
    refill INTEGER NOT NULL DEFAULT 0,
    cancel INTEGER NOT NULL DEFAULT 0,
    dripfeed INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    markup REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    service_id INTEGER NOT NULL,
    service_name TEXT NOT NULL,
    link TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    charge REAL NOT NULL,
    provider_order_id TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    start_count TEXT,
    remains TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS stars_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    telegram_id TEXT NOT NULL,
    stars INTEGER NOT NULL,
    credit REAL NOT NULL,
    charge_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `INSERT OR IGNORE INTO settings (key, value) VALUES
    ('site_name', 'TOTA SMM'),
    ('default_markup', '20'),
    ('min_deposit', '5'),
    ('currency', 'USD'),
    ('star_usd', '0.01'),
    ('topup_methods', 'كريمي كاش، جوالي، تحويل بنكي، USDT')`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
];

// Postgres dialect. Timestamps stay TEXT on purpose: the views print them
// as-is and the app compares them lexicographically, exactly as with SQLite.
const SCHEMA_PG = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    balance DOUBLE PRECISION NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (${NOW_SQL}),
    telegram_id TEXT,
    link_code TEXT,
    link_code_at TEXT,
    telegram_username TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg ON users (telegram_id) WHERE telegram_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (${NOW_SQL}),
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS services (
    service_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    type TEXT,
    rate DOUBLE PRECISION NOT NULL,
    min INTEGER NOT NULL DEFAULT 1,
    max INTEGER NOT NULL DEFAULT 1000000,
    refill INTEGER NOT NULL DEFAULT 0,
    cancel INTEGER NOT NULL DEFAULT 0,
    dripfeed INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    markup DOUBLE PRECISION,
    updated_at TEXT NOT NULL DEFAULT (${NOW_SQL})
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    service_id INTEGER NOT NULL,
    service_name TEXT NOT NULL,
    link TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    charge DOUBLE PRECISION NOT NULL,
    provider_order_id TEXT,
    status TEXT NOT NULL DEFAULT 'Pending',
    start_count TEXT,
    remains TEXT,
    created_at TEXT NOT NULL DEFAULT (${NOW_SQL}),
    updated_at TEXT NOT NULL DEFAULT (${NOW_SQL})
  )`,
  `CREATE TABLE IF NOT EXISTS deposits (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount DOUBLE PRECISION NOT NULL,
    method TEXT NOT NULL,
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (${NOW_SQL}),
    reviewed_at TEXT,
    photo_file_id TEXT,
    photo_path TEXT,
    photo_data TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS stars_payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    telegram_id TEXT NOT NULL,
    stars INTEGER NOT NULL,
    credit DOUBLE PRECISION NOT NULL,
    charge_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (${NOW_SQL})
  )`,
  `INSERT INTO settings (key, value) VALUES
    ('site_name', 'TOTA SMM'),
    ('default_markup', '20'),
    ('min_deposit', '5'),
    ('currency', 'USD'),
    ('star_usd', '0.01'),
    ('topup_methods', 'كريمي كاش، جوالي، تحويل بنكي، USDT')
    ON CONFLICT (key) DO NOTHING`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
];

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS,
// so each one is attempted and a "duplicate column" error is expected on re-run.
const MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN telegram_id TEXT',
  'ALTER TABLE users ADD COLUMN link_code TEXT',
  'ALTER TABLE users ADD COLUMN link_code_at TEXT',
  'ALTER TABLE users ADD COLUMN telegram_username TEXT',
  'ALTER TABLE deposits ADD COLUMN photo_file_id TEXT',
  'ALTER TABLE deposits ADD COLUMN photo_path TEXT',
  'ALTER TABLE deposits ADD COLUMN photo_data TEXT',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg ON users(telegram_id) WHERE telegram_id IS NOT NULL`,
];

let ready = null;

function init() {
  if (ready) return ready;
  ready = (async () => {
    if (MODE === 'pg') {
      for (const statement of SCHEMA_PG) await pgPool.query(statement);
      return true;
    }
    if (MODE === 'file') {
      await client.execute('PRAGMA journal_mode = WAL');
      await client.execute('PRAGMA foreign_keys = ON');
    }
    for (const statement of SCHEMA) {
      await client.execute(statement);
    }
    for (const statement of MIGRATIONS) {
      try {
        await client.execute(statement);
      } catch (err) {
        if (!/duplicate column|already exists/i.test(String(err.message))) throw err;
      }
    }
    return true;
  })();
  ready.catch(err => { ready = null; throw err; });
  return ready;
}

async function getSetting(key, fallback = null) {
  const row = await get('SELECT value FROM settings WHERE key = ?', key);
  return row && row.value != null ? row.value : fallback;
}

async function setSetting(key, value) {
  await run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, String(value));
}

module.exports = {
  client: MODE === 'pg' ? pgPool : client,
  all, get, run, batch, init, getSetting, setSetting,
  isRemote: MODE !== 'file',
  mode: MODE,
  // Exposed for the dialect test (test/pg-dialect.js): the Postgres DDL and the
  // placeholder/timestamp rewrite, checked against an in-memory Postgres.
  _internals: { SCHEMA_PG, toPg },
};
