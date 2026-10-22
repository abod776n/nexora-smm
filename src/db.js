'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@libsql/client');

const REMOTE_URL = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || '';
const REMOTE = Boolean(REMOTE_URL) && !REMOTE_URL.startsWith('file:');

let client;
if (REMOTE) {
  client = createClient({ url: REMOTE_URL, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
} else {
  // Serverless has a read-only project FS — fall back to /tmp so a missing
  // TURSO_DATABASE_URL degrades into a fresh ephemeral DB, not a crash.
  const ephemeral = process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME;
  const DATA_DIR = process.env.DATA_DIR || (ephemeral ? '/tmp/data' : path.join(__dirname, '..', 'data'));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  client = createClient({ url: 'file:' + path.join(DATA_DIR, 'app.db') });
}

function plain(row) {
  return row ? Object.assign({}, row) : row;
}

async function all(sql, ...args) {
  const res = await client.execute({ sql, args });
  return res.rows.map(plain);
}

async function get(sql, ...args) {
  const rows = await all(sql, ...args);
  return rows[0] || null;
}

async function run(sql, ...args) {
  const res = await client.execute({ sql, args });
  return {
    changes: Number(res.rowsAffected || 0),
    lastInsertRowid: res.lastInsertRowid != null ? Number(res.lastInsertRowid) : 0,
  };
}

// Execute several statements as one write transaction.
async function batch(statements) {
  if (!statements.length) return [];
  const out = [];
  for (let i = 0; i < statements.length; i += 400) {
    const chunk = statements.slice(i, i + 400).map(s =>
      typeof s === 'string' ? { sql: s, args: [] } : { sql: s.sql, args: s.args || [] }
    );
    const res = await client.batch(chunk, 'write');
    out.push(...res);
  }
  return out;
}

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

// Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS,
// so each one is attempted and a "duplicate column" error is expected on re-run.
const MIGRATIONS = [
  'ALTER TABLE users ADD COLUMN telegram_id TEXT',
  'ALTER TABLE users ADD COLUMN link_code TEXT',
  'ALTER TABLE users ADD COLUMN link_code_at TEXT',
  'ALTER TABLE users ADD COLUMN telegram_username TEXT',
  'ALTER TABLE deposits ADD COLUMN photo_file_id TEXT',
  'ALTER TABLE deposits ADD COLUMN photo_path TEXT',
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tg ON users(telegram_id) WHERE telegram_id IS NOT NULL`,
];

let ready = null;

function init() {
  if (ready) return ready;
  ready = (async () => {
    if (!REMOTE) {
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

module.exports = { client, all, get, run, batch, init, getSetting, setSetting, isRemote: REMOTE };
