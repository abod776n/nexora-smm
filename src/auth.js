'use strict';

const crypto = require('node:crypto');
const { run, get } = require('./db');

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, keyHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, userId, expires);
  return token;
}

async function destroySession(token) {
  if (token) await run('DELETE FROM sessions WHERE token = ?', token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie).session;
  if (!token) return null;
  const row = await get(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `, token);
  return row || null;
}

function sessionCookie(token) {
  const secure = process.env.SECURE_COOKIES === '1' ? '; Secure' : '';
  return `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

function clearCookie() {
  return 'session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

module.exports = { hashPassword, verifyPassword, createSession, destroySession, userFromRequest, sessionCookie, clearCookie, parseCookies };
