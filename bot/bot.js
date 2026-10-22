'use strict';

// Store bot: Telegram Stars top-up + account linking.
// Runs long polling inside the web process (no public URL / webhook needed),
// writes to the same database as the website.

const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, batch, getSetting } = require('../src/db');

// Deliberately NOT BOT_TOKEN: the container injects BOT_TOKEN for the personal
// assistant bot, which the platform polls itself. A second getUpdates on it
// conflicts and steals the owner's chat messages. The store bot has its own.
const TOKEN = process.env.STORE_BOT_TOKEN || '';
const STAR_PACKS = [50, 100, 250, 500, 1000, 2500];
const STAR_MIN = 1;
const STAR_MAX = 100000;

let offset = 0;
let running = false;

// Per-chat conversation state (custom star amount / deposit flow).
// In memory: a restart drops half-finished dialogs, which is acceptable.
const states = new Map();
const STATE_TTL = 15 * 60 * 1000;

function setState(chatId, state) {
  states.set(String(chatId), { ...state, at: Date.now() });
}
function getState(chatId) {
  const key = String(chatId);
  const st = states.get(key);
  if (!st) return null;
  if (Date.now() - st.at > STATE_TTL) {
    states.delete(key);
    return null;
  }
  return st;
}
function clearState(chatId) {
  states.delete(String(chatId));
}

async function call(method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, description: 'bad response' }));
  if (!data.ok) throw new Error(`${method}: ${data.description || 'failed'}`);
  return data.result;
}

const send = (chatId, text, extra = {}) =>
  call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra });

async function starRate() {
  const raw = Number(await getSetting('star_usd', '0.01'));
  return Number.isFinite(raw) && raw > 0 ? raw : 0.01;
}

const fmt = n => `$${Number(n).toFixed(2)}`;

async function userByTelegram(telegramId) {
  return get('SELECT * FROM users WHERE telegram_id = ?', String(telegramId));
}

async function linkUser(chatId, telegramId, username, code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return send(chatId, 'اكتب الكود بعد الأمر، مثال:\n/link AB12CD34');
  const row = await get(
    `SELECT id, link_code_at FROM users
     WHERE link_code = ? AND telegram_id IS NULL
       AND link_code_at IS NOT NULL AND link_code_at >= datetime('now', '-1 day')`,
    clean
  );
  if (!row) return send(chatId, 'الكود غير صحيح أو انتهت صلاحيته. اطلب كوداً جديداً من صفحة «حسابي» في الموقع.');

  const taken = await get('SELECT id FROM users WHERE telegram_id = ?', String(telegramId));
  if (taken) return send(chatId, 'حساب تيليجرام هذا مرتبط بحساب آخر في المتجر.');

  await run(
    `UPDATE users SET telegram_id = ?, telegram_username = ?, link_code = NULL, link_code_at = NULL
     WHERE id = ?`,
    String(telegramId), username || null, row.id
  );
  const user = await get('SELECT * FROM users WHERE id = ?', row.id);
  return send(chatId, `تم الربط بنجاح.\nالحساب: ${user.name}\nالرصيد الحالي: ${fmt(user.balance)}\n\n/add لشحن الرصيد بالنجوم.`);
}

async function balance(chatId, telegramId) {
  const user = await userByTelegram(telegramId);
  if (!user) return send(chatId, 'حساب تيليجرام غير مرتبط. افتح صفحة «حسابي» في الموقع واتبع خطوات الربط.');
  return send(chatId, `الرصيد المتاح: ${fmt(user.balance)}`);
}

async function topupMenu(chatId, telegramId) {
  const user = await userByTelegram(telegramId);
  if (!user) return send(chatId, 'اربط حسابك أولاً من صفحة «حسابي» في الموقع، ثم أعد المحاولة.');
  const rate = await starRate();
  const buttons = STAR_PACKS.map(stars => {
    const credit = stars * rate;
    return [{ text: `${stars} نجمة = ${fmt(credit)}`, callback_data: `buy:${stars}` }];
  });
  buttons.push([{ text: '✏️ عدد مخصص من النجوم', callback_data: 'custom' }]);
  return send(chatId, 'اختر باقة الشحن، أو اكتب عدد النجوم الذي تريده. الرصيد يضاف فوراً بعد الدفع.', {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function askCustomStars(chatId, telegramId) {
  const user = await userByTelegram(telegramId);
  if (!user) return send(chatId, 'اربط حسابك أولاً من صفحة «حسابي» في الموقع، ثم أعد المحاولة.');
  const rate = await starRate();
  setState(chatId, { step: 'stars', telegramId });
  return send(chatId,
    `اكتب عدد النجوم الذي تريده (من ${STAR_MIN} إلى ${STAR_MAX}).\n` +
    `سعر النجمة: ${fmt(rate)} — مثال: 37 نجمة = ${fmt(37 * rate)}.\n\n` +
    'أرسل /cancel للإلغاء.');
}

async function sendInvoice(chatId, telegramId, stars) {
  if (!Number.isInteger(stars) || stars < STAR_MIN || stars > STAR_MAX) {
    return send(chatId, `العدد يجب أن يكون بين ${STAR_MIN} و${STAR_MAX} نجمة.`);
  }
  const user = await userByTelegram(telegramId);
  if (!user) return;

  const payload = `stars:${user.id}:${stars}:${Date.now()}`;
  try {
    await call('sendInvoice', {
      chat_id: chatId,
      title: `${stars} نجمة تيليجرام`,
      description: `شحن رصيد المتجر بمبلغ ${fmt(stars * await starRate())}`,
      payload,
      provider_token: '', // Stars are paid with an empty provider token
      currency: 'XTR',
      prices: [{ label: 'نجوم', amount: stars }],
    });
  } catch (err) {
    console.error('[bot] sendInvoice failed:', err.message);
    await send(chatId, 'تعذّر إنشاء فاتورة النجوم. تأكد أن المتجر مفعّل للدفع بالنجوم ثم حاول لاحقاً.');
  }
}

async function onPreCheckout(q) {
  try {
    await call('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: true });
  } catch (err) {
    console.error('[bot] pre_checkout answer failed:', err.message);
  }
}

async function onPaid(message) {
  const payment = message.successful_payment;
  if (!payment) return;
  const chatId = message.chat.id;
  const telegramId = String(message.from.id);
  const stars = Number(payment.total_amount) || 0;
  const chargeId = payment.telegram_payment_charge_id;

  const user = await userByTelegram(telegramId);
  if (!user) {
    console.error('[bot] paid but no linked user:', telegramId, chargeId);
    return send(chatId, 'تم الدفع لكن حسابك غير مرتبط بالمتجر. راسل الإدارة مع رقم العملية: ' + chargeId);
  }

  const seen = await get('SELECT id FROM stars_payments WHERE charge_id = ?', chargeId);
  if (seen) return send(chatId, 'تم تسجيل هذه العملية مسبقاً.');

  const credit = Math.round(stars * (await starRate()) * 100) / 100;
  try {
    await batch([
      {
        sql: `INSERT INTO stars_payments (user_id, telegram_id, stars, credit, charge_id)
              VALUES (?, ?, ?, ?, ?)`,
        args: [user.id, telegramId, stars, credit, chargeId],
      },
      { sql: 'UPDATE users SET balance = balance + ? WHERE id = ?', args: [credit, user.id] },
      {
        sql: `INSERT INTO deposits (user_id, amount, method, reference, status, note, reviewed_at)
              VALUES (?, ?, 'نجوم تيليجرام', ?, 'approved', ?, datetime('now'))`,
        args: [user.id, credit, chargeId, `${stars} نجمة`],
      },
    ]);
  } catch (err) {
    console.error('[bot] credit failed:', err.message);
    return send(chatId, 'تم الدفع لكن حصل خطأ في إضافة الرصيد. راسل الإدارة مع رقم العملية: ' + chargeId);
  }

  const fresh = await get('SELECT balance FROM users WHERE id = ?', user.id);
  return send(chatId, `تم شحن ${fmt(credit)} (${stars} نجمة).\nرصيدك الآن: ${fmt(fresh.balance)}`);
}

// ---------- wallet deposit (Jeeb / local wallets) ----------
// Telegram cannot verify a wallet transfer by itself: there is no public API
// for Jeeb or the other local wallets. The flow below collects amount, transfer
// reference and the receipt photo, then sends them to the admin with one-tap
// approve/reject. Credit is applied the moment the admin taps approve.

const { parseWallets } = require('../src/wallets');

async function adminTelegramId() {
  const row = await get(
    'SELECT telegram_id FROM users WHERE is_admin = 1 AND telegram_id IS NOT NULL ORDER BY id LIMIT 1'
  );
  return row ? String(row.telegram_id) : null;
}

function walletsFromSetting(raw) {
  return parseWallets(raw).map(w => {
    const urlMatch = w.number.match(/^https?:\/\/\S+$/i);
    return { ...w, url: urlMatch ? w.number : null };
  });
}

async function depositMenu(chatId, telegramId) {
  const user = await userByTelegram(telegramId);
  if (!user) return send(chatId, 'اربط حسابك أولاً من صفحة «حسابي» في الموقع، ثم أعد المحاولة.');
  const wallets = walletsFromSetting(await getSetting('topup_wallets', ''));
  if (!wallets.length) return send(chatId, 'لا توجد وسائل شحن مضبوطة حالياً. راسل الإدارة.');

  const lines = ['حوّل المبلغ إلى إحدى المحافظ التالية، ثم أرسل لنا رقم العملية وصورة الإيداع:', ''];
  wallets.forEach((w, i) => {
    const dest = w.url ? `${w.url}` : (w.number || '—');
    lines.push(`${i + 1}) ${w.name} — ${dest}${w.holder ? ` (${w.holder})` : ''}`);
  });
  lines.push('', 'اختر الوسيلة من الأزرار:');
  const buttons = wallets.map((w, i) => [{ text: w.name, callback_data: `depm:${i}` }]);
  return send(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: buttons } });
}

async function pickDepositMethod(chatId, telegramId, index) {
  const user = await userByTelegram(telegramId);
  if (!user) return;
  const wallets = walletsFromSetting(await getSetting('topup_wallets', ''));
  const w = wallets[index];
  if (!w) return send(chatId, 'الوسيلة غير متاحة، أرسل /deposit من جديد.');
  const dest = w.url ? `${w.number}` : (w.number || '—');
  setState(chatId, { step: 'dep_amount', telegramId, method: w.name });
  return send(chatId,
    `الوسيلة: ${w.name}\nالوجهة: ${dest}${w.holder ? `\nالاسم: ${w.holder}` : ''}\n\n` +
    'بعد التحويل اكتب المبلغ بالدولار (مثال: 10).\nأرسل /cancel للإلغاء.');
}

async function onDepositAmount(chatId, state, text) {
  const amount = Number(String(text).replace(',', '.').trim());
  const min = Number(await getSetting('min_deposit', '5')) || 1;
  if (!Number.isFinite(amount) || amount <= 0) {
    return send(chatId, 'أرسل المبلغ كرقم، مثال: 10');
  }
  if (amount < min) return send(chatId, `أقل مبلغ شحن هو ${fmt(min)}.`);
  if (amount > 10000) return send(chatId, 'المبلغ كبير جداً. راسل الإدارة مباشرة.');
  setState(chatId, { ...state, step: 'dep_reference', amount: Math.round(amount * 100) / 100 });
  return send(chatId, 'اكتب رقم عملية التحويل كما يظهر في إشعار المحفظة.');
}

async function onDepositReference(chatId, state, text) {
  const reference = String(text).trim().slice(0, 120);
  if (reference.length < 3) return send(chatId, 'رقم العملية قصير جداً. اكتب رقم العملية كاملاً.');
  setState(chatId, { ...state, step: 'dep_photo', reference });
  return send(chatId, 'أرسل الآن صورة إشعار الإيداع (لقطة الشاشة).');
}

// Send a receipt photo that lives on disk (web uploads) via multipart.
async function callWithPhoto(method, fields, filePath) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  const buf = await fs.promises.readFile(filePath);
  fd.append('photo', new Blob([buf], { type: 'image/jpeg' }), path.basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({ ok: false, description: 'bad response' }));
  if (!data.ok) throw new Error(`${method}: ${data.description || 'failed'}`);
  return data.result;
}

async function pushDepositToAdmin(d) {
  const adminId = await adminTelegramId();
  if (!adminId) {
    console.error('[bot] deposit created without an admin telegram id:', d.id);
    return;
  }
  const who = d.user_name || d.name || `#${d.user_id}`;
  const username = d.telegram_username || '';
  const caption =
    `طلب إيداع #${d.id}\n` +
    `العميل: ${who}${username ? ` (@${username})` : ''}\n` +
    `المبلغ: ${fmt(d.amount)}\nالوسيلة: ${d.method}\nرقم العملية: ${d.reference || '—'}\n` +
    `المصدر: ${d.note || 'البوت'}` +
    (d.telegram_id ? `\nTelegram ID: ${d.telegram_id}` : '');
  const keyboard = {
    inline_keyboard: [[
      { text: 'موافقة وإضافة الرصيد', callback_data: `dep:${d.id}:ok` },
      { text: 'رفض', callback_data: `dep:${d.id}:no` },
    ]],
  };

  try {
    if (d.photo_file_id) {
      return await call('sendPhoto', {
        chat_id: adminId, photo: d.photo_file_id, caption, reply_markup: keyboard,
      });
    }
    if (d.photo_path) {
      const abs = path.join(__dirname, '..', 'uploads', path.basename(d.photo_path));
      if (fs.existsSync(abs)) {
        return await callWithPhoto('sendPhoto', {
          chat_id: adminId, caption, reply_markup: keyboard,
        }, abs);
      }
    }
    return await call('sendMessage', { chat_id: adminId, text: caption, reply_markup: keyboard });
  } catch (err) {
    console.error('[bot] admin notify failed:', err.message);
    await call('sendMessage', { chat_id: adminId, text: caption, reply_markup: keyboard }).catch(() => {});
  }
}

// Called from the website after a deposit row is created.
async function notifyDeposit(depositId) {
  const d = await get(
    `SELECT d.*, u.name AS user_name, u.telegram_username, u.telegram_id
     FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.id = ?`,
    depositId
  );
  if (!d) return;
  return pushDepositToAdmin(d);
}

async function onDepositPhoto(chatId, state, message) {
  const user = await userByTelegram(state.telegramId);
  if (!user) {
    clearState(chatId);
    return send(chatId, 'حسابك غير مرتبط. اربطه من صفحة «حسابي».');
  }
  const photo = message.photo[message.photo.length - 1];
  const fileId = photo ? photo.file_id : null;
  if (!fileId) return send(chatId, 'أرسل صورة الإشعار كصورة، لا كملف.');

  const created = await run(
    `INSERT INTO deposits (user_id, amount, method, reference, status, note, photo_file_id)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    user.id, state.amount, state.method, state.reference, 'إيداع عبر البوت', fileId
  );
  const depositId = created.lastInsertRowid;
  clearState(chatId);

  await send(chatId,
    `تم استلام طلب الإيداع #${depositId}.\nالمبلغ: ${fmt(state.amount)} — ${state.method}\n` +
    'سيُضاف الرصيد بعد التحقق من الإدارة، وعادة خلال دقائق.');

  const fresh = await get(
    `SELECT d.*, u.name AS user_name, u.telegram_username, u.telegram_id
     FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.id = ?`, depositId
  );
  if (fresh) await pushDepositToAdmin(fresh);
}

async function reviewDeposit(q, depositId, decision) {
  const adminId = await adminTelegramId();
  if (!adminId || String(q.from.id) !== adminId) {
    return send(q.message.chat.id, 'هذا الزر للإدارة فقط.');
  }
  const d = await get("SELECT * FROM deposits WHERE id = ? AND status = 'pending'", depositId);
  if (!d) {
    return call('editMessageReplyMarkup', {
      chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  const user = await get('SELECT * FROM users WHERE id = ?', d.user_id);

  if (decision === 'ok') {
    await batch([
      {
        sql: "UPDATE deposits SET status = 'approved', reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'",
        args: [d.id],
      },
      { sql: 'UPDATE users SET balance = balance + ? WHERE id = ?', args: [d.amount, d.user_id] },
    ]);
  } else {
    await run("UPDATE deposits SET status = 'rejected', reviewed_at = datetime('now') WHERE id = ?", d.id);
  }

  const verdict = decision === 'ok' ? 'موافَق عليه — أُضيف الرصيد' : 'مرفوض';
  try {
    await call('editMessageCaption', {
      chat_id: q.message.chat.id,
      message_id: q.message.message_id,
      caption: `${q.message.caption || `طلب إيداع #${d.id}`}\n\nالحالة: ${verdict}`,
      reply_markup: { inline_keyboard: [] },
    });
  } catch {}

  if (user && user.telegram_id) {
    const text = decision === 'ok'
      ? `تمت الموافقة على إيداعك #${d.id} بمبلغ ${fmt(d.amount)}.\nرصيدك الآن: ${fmt((Number(user.balance) || 0) + Number(d.amount))}`
      : `تم رفض إيداعك #${d.id}. راسل الإدارة إن كنت تعتقد أن هناك خطأ.`;
    await send(user.telegram_id, text).catch(() => {});
  }
}

async function onCommand(message, text) {
  const chatId = message.chat.id;
  const telegramId = String(message.from.id);
  const username = message.from.username || null;
  const [cmdRaw, ...rest] = text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().split('@')[0];

  if (cmd === '/start') {
    const user = await userByTelegram(telegramId);
    if (rest[0] === 'topup' && user) return topupMenu(chatId, telegramId);
    if (rest[0] === 'deposit' && user) return depositMenu(chatId, telegramId);
    if (user) return send(chatId, `أهلاً ${user.name}.\n/balance — رصيدك\n/add — شحن بالنجوم\n/deposit — إيداع عبر محفظة جيب أو محفظة محلية\n/orders — آخر طلباتك`);
    return send(chatId,
      'أهلاً بك في متجرنا.\nلربط حسابك: افتح الموقع → «حسابي» → انسخ كود الربط → أرسله هنا:\n/link الكود');
  }
  if (cmd === '/link') return linkUser(chatId, telegramId, username, rest[0]);
  if (cmd === '/cancel' || cmd === '/الغاء') {
    clearState(chatId);
    return send(chatId, 'تم الإلغاء.');
  }
  if (cmd === '/balance' || cmd === '/رصيد') return balance(chatId, telegramId);
  if (cmd === '/add' || cmd === '/topup' || cmd === '/شحن') return topupMenu(chatId, telegramId);
  if (cmd === '/deposit' || cmd === '/ايداع' || cmd === '/إيداع') return depositMenu(chatId, telegramId);
  if (cmd === '/orders' || cmd === '/طلبات') {
    const user = await userByTelegram(telegramId);
    if (!user) return send(chatId, 'اربط حسابك أولاً من صفحة «حسابي» في الموقع.');
    const rows = await all('SELECT id, service_name, quantity, charge, status FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 10', user.id);
    if (!rows.length) return send(chatId, 'ما عندك طلبات بعد.');
    return send(chatId, rows.map(o =>
      `#${o.id} — ${o.service_name}\n${o.quantity} × ${fmt(o.charge)} — ${o.status}`).join('\n\n'));
  }
  if (cmd === '/id') return send(chatId, `Telegram ID: ${telegramId}`);
}

async function onUpdate(update) {
  if (update.pre_checkout_query) return onPreCheckout(update.pre_checkout_query);

  if (update.callback_query) {
    const q = update.callback_query;
    const data = String(q.data || '');
    try { await call('answerCallbackQuery', { callback_query_id: q.id }); } catch {}
    const chatId = q.message && q.message.chat ? q.message.chat.id : null;
    if (!chatId) return;
    if (data.startsWith('buy:')) {
      return sendInvoice(chatId, String(q.from.id), Number(data.slice(4)));
    }
    if (data === 'custom') return askCustomStars(chatId, String(q.from.id));
    if (data.startsWith('depm:')) {
      return pickDepositMethod(chatId, String(q.from.id), Number(data.slice(5)));
    }
    if (data.startsWith('dep:')) {
      const [, id, decision] = data.split(':');
      return reviewDeposit(q, Number(id), decision);
    }
    return;
  }

  const message = update.message;
  if (!message || !message.from || message.from.is_bot) return;
  if (message.successful_payment) return onPaid(message);

  const chatId = message.chat.id;
  const text = message.text || '';

  // Commands always win and reset any pending dialog (except /cancel handling below).
  if (text.startsWith('/')) {
    if (!/^\/(cancel|الغاء)(@|$|\s)/i.test(text)) clearState(chatId);
    return onCommand(message, text);
  }

  const state = getState(chatId);
  if (!state) {
    if (message.photo) {
      return send(chatId, 'لإرسال إيداع أرسل /deposit أولاً.');
    }
    return;
  }

  if (state.step === 'stars') {
    const stars = Number(text.trim());
    if (!Number.isInteger(stars) || stars < STAR_MIN || stars > STAR_MAX) {
      return send(chatId, `اكتب عدداً صحيحاً بين ${STAR_MIN} و${STAR_MAX}، مثال: 37. أو /cancel للإلغاء.`);
    }
    clearState(chatId);
    return sendInvoice(chatId, state.telegramId || String(message.from.id), stars);
  }
  if (state.step === 'dep_amount') return onDepositAmount(chatId, state, text);
  if (state.step === 'dep_reference') return onDepositReference(chatId, state, text);
  if (state.step === 'dep_photo') {
    if (!message.photo) return send(chatId, 'أرسل لقطة شاشة لإشعار الإيداع كصورة.');
    return onDepositPhoto(chatId, state, message);
  }
}

async function poll() {
  while (running) {
    try {
      const updates = await call('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await onUpdate(update);
        } catch (err) {
          console.error('[bot] update failed:', err.message);
        }
      }
    } catch (err) {
      console.error('[bot] polling error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function start() {
  if (!TOKEN) {
    console.log('[bot] STORE_BOT_TOKEN not set — store bot disabled');
    return;
  }
  running = true;
  try {
    const me = await call('getMe');
    if (!process.env.STORE_BOT_USERNAME) process.env.STORE_BOT_USERNAME = me.username;
    console.log(`[bot] polling as @${me.username}`);
  } catch (err) {
    console.error('[bot] getMe failed:', err.message);
  }
  poll();
}

module.exports = { start, notifyDeposit };
