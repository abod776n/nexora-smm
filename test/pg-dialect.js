'use strict';

// Checks the Postgres side of src/db.js against a real Postgres engine
// (PGlite, WASM) — DDL, placeholder rewriting and datetime('now') translation.
// Run: node test/pg-dialect.js

const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');
const { _internals } = require('../src/db');

const { SCHEMA_PG, toPg } = _internals;

async function main() {
  const pg = new PGlite();

  const q = (sql, args = []) => pg.query(toPg(sql), args);
  const one = async (sql, args = []) => (await q(sql, args)).rows[0];

  for (const statement of SCHEMA_PG) await pg.query(statement);

  // placeholder rewriting must not touch SQL without placeholders
  assert.strictEqual(toPg('SELECT 1'), 'SELECT 1');
  assert.strictEqual(toPg('SELECT ?, ?'), 'SELECT $1, $2');

  // users: autoincrement id + default timestamp in the SQLite text shape
  let res = await q('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id',
    ['a@b.co', 'عبود', 'hash']);
  assert.strictEqual(Number(res.rows[0].id), 1);

  const user = await one('SELECT * FROM users WHERE email = ?', ['a@b.co']);
  assert.strictEqual(user.name, 'عبود');
  assert.match(String(user.created_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.strictEqual(Number(user.balance), 0);

  // case-insensitive uniqueness like COLLATE NOCASE used to give
  await assert.rejects(q('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)',
    ['A@B.CO', 'dup', 'h']));

  // settings upsert (setSetting)
  const upsert = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  await q(upsert, ['site_name', 'X']);
  await q(upsert, ['site_name', 'Y']);
  assert.strictEqual((await one("SELECT value FROM settings WHERE key = 'site_name'")).value, 'Y');

  // services sync statement (provider has ON CONFLICT already in SQL)
  const svc = `INSERT INTO services (service_id, name, category, type, rate, min, max, refill, cancel, dripfeed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(service_id) DO UPDATE SET name = excluded.name, rate = excluded.rate, updated_at = excluded.updated_at`;
  await q(svc, [10, 'متابعين', 'انستقرام', 'Default', 0.5, 10, 1000, 0, 0, 0]);
  await q(svc, [10, 'متابعين 2', 'انستقرام', 'Default', 0.7, 10, 1000, 0, 0, 0]);
  const s = await one('SELECT name, rate FROM services WHERE service_id = ?', [10]);
  assert.strictEqual(s.name, 'متابعين 2');
  assert.strictEqual(Number(s.rate), 0.7);

  // sessions: ISO string from JS compared against datetime('now')
  await q('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)',
    ['tok', 1, new Date(Date.now() + 86400e3).toISOString()]);
  const live = await one(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')`, ['tok']);
  assert.ok(live, 'live session must be found');

  // deposits with the receipt kept in the database
  res = await q(`INSERT INTO deposits (user_id, amount, method, reference, note, photo_path, photo_data)
    VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [1, 10, 'كريمي', '123', 'إيداع', 'r.jpg', Buffer.from('x').toString('base64')]);
  assert.strictEqual(Number(res.rows[0].id), 1);

  // orders + aggregates (COUNT comes back as int8 → the pool parser makes it a Number)
  res = await q(`INSERT INTO orders (user_id, service_id, service_name, link, quantity, charge)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`, [1, 10, 'متابعين', 'https://x', 100, 0.7]);
  assert.strictEqual(Number(res.rows[0].id), 1);
  await q("UPDATE orders SET status = 'Completed', updated_at = datetime('now') WHERE id = ?", [1]);
  const agg = await one("SELECT COUNT(*) AS c, COALESCE(SUM(charge),0) AS s FROM orders WHERE status != 'Failed'");
  assert.strictEqual(Number(agg.c), 1);
  assert.strictEqual(Number(agg.s), 0.7);

  // stars payments
  await q('INSERT INTO stars_payments (user_id, telegram_id, stars, credit, charge_id) VALUES (?, ?, ?, ?, ?)',
    [1, '5878518779', 50, 0.5, 'ch_1']);
  await assert.rejects(q('INSERT INTO stars_payments (user_id, telegram_id, stars, credit, charge_id) VALUES (?, ?, ?, ?, ?)',
    [1, '5878518779', 50, 0.5, 'ch_1']));

  // partial unique index on telegram_id
  await q('UPDATE users SET telegram_id = ? WHERE id = ?', ['111', 1]);
  await assert.rejects(q('INSERT INTO users (email, name, password_hash, telegram_id) VALUES (?, ?, ?, ?)',
    ['c@d.co', 'dup', 'h', '111']));

  console.log('pg dialect OK');
}

main().catch(err => { console.error(err); process.exit(1); });
