'use strict';

const { all, get, batch, getSetting, setSetting } = require('./db');

const API_URL = process.env.TOTA_API_URL || 'https://bot.tota.click/api/v2';
const API_KEY = process.env.TOTA_API_KEY || '';

async function api(action, params = {}) {
  if (!API_KEY) throw new Error('TOTA_API_KEY غير مضبوط في البيئة');
  const body = new URLSearchParams({ key: API_KEY, action, ...params });
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`المزوّد رجّع HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error) throw new Error(String(data.error));
  return data;
}

async function fetchBalance() {
  return api('balance');
}

async function syncServices() {
  const list = await api('services');
  if (!Array.isArray(list)) throw new Error('رد المزوّد غير متوقع عند جلب الخدمات');
  const statements = list.map(s => ({
    sql: `INSERT INTO services (service_id, name, category, type, rate, min, max, refill, cancel, dripfeed, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(service_id) DO UPDATE SET
        name = excluded.name, category = excluded.category, type = excluded.type,
        rate = excluded.rate, min = excluded.min, max = excluded.max,
        refill = excluded.refill, cancel = excluded.cancel, dripfeed = excluded.dripfeed,
        updated_at = excluded.updated_at`,
    args: [
      Number(s.service), String(s.name || ''), String(s.category || 'أخرى'), String(s.type || 'Default'),
      Number(s.rate) || 0, Number(s.min) || 1, Number(s.max) || 1000000,
      s.refill ? 1 : 0, s.cancel ? 1 : 0, s.dripfeed ? 1 : 0,
    ],
  }));
  await batch(statements);
  await setSetting('services_synced_at', new Date().toISOString());
  const count = (await get('SELECT COUNT(*) AS c FROM services')).c;
  return { synced: list.length, stored: Number(count) };
}

async function effectiveRate(service) {
  const fallback = await getSetting('default_markup', '20');
  const markup = service.markup == null ? Number(fallback) : Number(service.markup);
  return service.rate * (1 + markup / 100);
}

async function priceFor(service, quantity) {
  // rate is USD per 1000 units; keep 4 decimal places (sub-cent prices are normal)
  const rate = await effectiveRate(service);
  return Math.round((rate * quantity / 1000) * 10000) / 10000;
}

async function listServices({ category, q, onlyEnabled = true } = {}) {
  const where = [];
  const params = [];
  if (onlyEnabled) where.push('enabled = 1');
  if (category) { where.push('category = ?'); params.push(category); }
  if (q) { where.push('(name LIKE ? OR category LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const sql = `SELECT * FROM services ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY category, rate ASC`;
  return all(sql, ...params);
}

async function listCategories() {
  return all('SELECT category, COUNT(*) AS count FROM services WHERE enabled = 1 GROUP BY category ORDER BY count DESC');
}

async function getService(id) {
  return get('SELECT * FROM services WHERE service_id = ?', Number(id));
}

async function placeOrder({ serviceId, link, quantity }) {
  return api('add', { service: serviceId, link, quantity });
}

async function orderStatus(orderId) {
  return api('status', { order: orderId });
}

module.exports = { api, fetchBalance, syncServices, listServices, listCategories, getService, effectiveRate, priceFor, placeOrder, orderStatus };
