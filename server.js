'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const db = require('./src/db');
const { all, get, run, batch, init, getSetting, setSetting } = db;
const auth = require('./src/auth');
const tota = require('./src/tota');
const views = require('./src/views');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SITE = () => getSetting('site_name', 'TOTA SMM');
// Store bot credentials are separate from BOT_TOKEN (the personal assistant bot).
const BOT_USERNAME = () => String(process.env.STORE_BOT_USERNAME || '').replace(/^@/, '');
const STARS_ON = () => Boolean(process.env.STORE_BOT_TOKEN);

// One-time code the user types as /link CODE in the store bot.
const newLinkCode = () => crypto.randomBytes(4).toString('hex').toUpperCase();
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Receipt photos for wallet deposits. Kept inside the app folder so they
// survive container updates (workspace is persistent).
// Serverless (Netlify) has a read-only project FS: receipts go to /tmp there.
const SERVERLESS = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
// Netlify sets URL itself, so the owner only needs PUBLIC_URL on other hosts.
const PUBLIC_BASE = String(
  process.env.PUBLIC_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || ''
).replace(/\/$/, '');
const UPLOAD_DIR = process.env.UPLOAD_DIR || (SERVERLESS ? '/tmp/uploads' : path.join(__dirname, 'uploads'));
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (err) { console.error('[uploads]', err.message); }
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safe = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safe}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, /^image\/(jpe?g|png|webp)$/i.test(file.mimetype || ''));
  },
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const uploadReceipt = (req, res, next) => upload.single('photo')(req, res, err => {
  if (err) return fail(res, '/topup', 'تعذّر رفع الصورة — استخدم صورة JPG أو PNG أقل من 8 ميجا.');
  next();
});

let botModule = null;
const storeBot = () => (botModule ||= require('./bot/bot'));

app.use(wrap(async (req, res, next) => {
  req.user = await auth.userFromRequest(req);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}));

// Same-origin check for state-changing requests
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    if (new URL(origin).host !== req.headers.host) return res.status(403).send('Forbidden');
  } catch { return res.status(403).send('Forbidden'); }
  next();
});

function requireUser(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (!req.user.is_admin) return res.status(403).send('Forbidden');
  next();
}

function fail(res, url, message) {
  res.redirect(url + (url.includes('?') ? '&' : '?') + 'err=' + encodeURIComponent(message));
}
function ok(res, url, message) {
  res.redirect(url + (url.includes('?') ? '&' : '?') + 'ok=' + encodeURIComponent(message));
}
function str(v, max = 500) {
  return String(v == null ? '' : v).trim().slice(0, max);
}
function nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// Stored as newline-separated "name | number | holder" (see src/wallets.js).
const { parseWallets, walletsText } = require('./src/wallets');

// ---------- public ----------

app.get('/', wrap(async (req, res) => {
  const category = str(req.query.category, 80) || '';
  const q = str(req.query.q, 80);
  const services = await tota.listServices({ category, q });
  const categories = await tota.listCategories();
  const defaultMarkup = await getSetting('default_markup', '20');
  res.send(views.catalogPage(req, { user: req.user, siteName: await SITE(), services, categories, category, q, defaultMarkup }));
}));

app.get('/order/:id', wrap(async (req, res) => {
  const service = await tota.getService(req.params.id);
  const siteName = await SITE();
  if (!service || (!service.enabled && !(req.user && req.user.is_admin))) {
    return res.status(404).send(views.page(req, {
      title: 'غير موجود', user: req.user, siteName,
      body: '<section class="auth-card"><h1>الخدمة غير متاحة</h1><p class="muted">ربما أُوقفت أو تغيّر رقمها. <a href="/">رجوع للخدمات</a></p></section>',
    }));
  }
  const defaultMarkup = await getSetting('default_markup', '20');
  res.send(views.orderPage(req, { user: req.user, siteName, service, defaultMarkup }));
}));

app.get('/login', wrap(async (req, res) => {
  if (req.user) return res.redirect('/account');
  res.send(views.authPage({ user: null, siteName: await SITE(), mode: 'login' }));
}));

app.get('/register', wrap(async (req, res) => {
  if (req.user) return res.redirect('/account');
  res.send(views.authPage({ user: null, siteName: await SITE(), mode: 'register' }));
}));

async function setSession(res, userId) {
  const token = await auth.createSession(userId);
  res.setHeader('Set-Cookie', auth.sessionCookie(token));
}

app.post('/register', wrap(async (req, res) => {
  const name = str(req.body.name, 60);
  const email = str(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  const siteName = await SITE();
  const errorPage = error => views.authPage({ user: null, siteName, mode: 'register', error });
  if (name.length < 2) return res.send(errorPage('اكتب اسمك (حرفان على الأقل).'));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.send(errorPage('البريد الإلكتروني غير صحيح.'));
  if (password.length < 6) return res.send(errorPage('كلمة المرور يجب أن تكون 6 أحرف على الأقل.'));
  const exists = await get('SELECT id FROM users WHERE email = ?', email);
  if (exists) return res.send(errorPage('هذا البريد مسجّل بالفعل. جرّب الدخول.'));
  const info = await run('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)', email, name, auth.hashPassword(password));
  await setSession(res, info.lastInsertRowid);
  res.redirect('/account');
}));

app.post('/login', wrap(async (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  const password = String(req.body.password || '');
  const user = await get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return res.send(views.authPage({ user: null, siteName: await SITE(), mode: 'login', error: 'البريد أو كلمة المرور غير صحيحة.' }));
  }
  await setSession(res, user.id);
  res.redirect('/account');
}));

app.post('/logout', wrap(async (req, res) => {
  const token = auth.parseCookies(req.headers.cookie).session;
  await auth.destroySession(token);
  res.setHeader('Set-Cookie', auth.clearCookie());
  res.redirect('/');
}));

app.get('/account', requireUser, wrap(async (req, res) => {
  const orders = await all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id);
  const deposits = await all('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id);

  let telegram = null;
  if (STARS_ON()) {
    if (req.user.telegram_id) {
      telegram = { linked: true, username: req.user.telegram_username, bot: BOT_USERNAME() };
    } else {
      const issuedAt = req.user.link_code_at ? Date.parse(req.user.link_code_at.replace(' ', 'T') + 'Z') : 0;
      let code = req.user.link_code;
      if (!code || !issuedAt || Date.now() - issuedAt > CODE_TTL_MS) {
        code = newLinkCode();
        await run("UPDATE users SET link_code = ?, link_code_at = datetime('now') WHERE id = ?", code, req.user.id);
      }
      telegram = { linked: false, code, bot: BOT_USERNAME() };
    }
  }

  res.send(views.accountPage(req, { user: req.user, siteName: await SITE(), orders, deposits, telegram }));
}));

app.post('/order', requireUser, wrap(async (req, res) => {
  const service = await tota.getService(req.body.service_id);
  const back = `/order/${str(req.body.service_id, 20) || ''}`;
  if (!service || !service.enabled) return fail(res, '/', 'الخدمة غير متاحة.');
  const link = str(req.body.link, 500);
  const quantity = Number(req.body.quantity);
  if (!link) return fail(res, back, 'اكتب رابط المنشور أو الحساب.');
  if (!Number.isInteger(quantity) || quantity < service.min || quantity > service.max) {
    return fail(res, back, `الكمية يجب أن تكون بين ${service.min} و${service.max}.`);
  }
  const price = await tota.priceFor(service, quantity);
  if (price <= 0) return fail(res, back, 'تعذّر حساب السعر. راسل الإدارة.');

  const charge = await run('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?', price, req.user.id, price);
  if (!charge.changes) return fail(res, '/topup', 'الرصيد غير كافٍ. اشحن حسابك ثم أعد المحاولة.');

  let orderId;
  try {
    const info = await run(`INSERT INTO orders (user_id, service_id, service_name, link, quantity, charge, status)
      VALUES (?, ?, ?, ?, ?, ?, 'Creating')`, req.user.id, service.service_id, service.name, link, quantity, price);
    orderId = info.lastInsertRowid;
  } catch (err) {
    await run('UPDATE users SET balance = balance + ? WHERE id = ?', price, req.user.id);
    throw err;
  }

  try {
    const result = await tota.placeOrder({ serviceId: service.service_id, link, quantity });
    if (!result || !result.order) throw new Error('لم يصل رقم طلب من المزوّد');
    await run("UPDATE orders SET provider_order_id = ?, status = 'Pending', updated_at = datetime('now') WHERE id = ?",
      String(result.order), orderId);
    ok(res, '/account', `تم إنشاء الطلب #${orderId} ودفع ${views.money(price)} من رصيدك.`);
  } catch (err) {
    await run('UPDATE users SET balance = balance + ? WHERE id = ?', price, req.user.id);
    await run("UPDATE orders SET status = 'Failed', updated_at = datetime('now') WHERE id = ?", orderId);
    fail(res, '/account', `تعذّر إرسال الطلب للمزوّد: ${err.message}. أُعيد المبلغ لرصيدك.`);
  }
}));

app.post('/account/orders/:id/refresh', requireUser, wrap(async (req, res) => {
  const order = await get('SELECT * FROM orders WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  if (!order) return fail(res, '/account', 'الطلب غير موجود.');
  if (!order.provider_order_id) return fail(res, '/account', 'لا يوجد رقم طلب لدى المزوّد بعد.');
  try {
    const st = await tota.orderStatus(order.provider_order_id);
    await run(`UPDATE orders SET status = ?, start_count = ?, remains = ?, updated_at = datetime('now') WHERE id = ?`,
      String(st.status || order.status), st.start_count == null ? null : String(st.start_count), st.remains == null ? null : String(st.remains), order.id);
    ok(res, '/account', 'تم تحديث حالة الطلب.');
  } catch (err) {
    fail(res, '/account', `تعذّر تحديث الحالة: ${err.message}`);
  }
}));

app.get('/topup', requireUser, wrap(async (req, res) => {
  const methods = await getSetting('topup_methods', 'كريمي كاش، جوالي، تحويل بنكي، USDT');
  const wallets = parseWallets(await getSetting('topup_wallets', ''));
  res.send(views.topupPage(req, {
    user: req.user, siteName: await SITE(), methods, wallets,
    minDeposit: Number(await getSetting('min_deposit', '5')),
    botUsername: BOT_USERNAME(),
  }));
}));

app.post('/topup', requireUser, uploadReceipt, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  const method = str(req.body.method, 60);
  const reference = str(req.body.reference, 120);
  const min = Number(await getSetting('min_deposit', '5'));
  const receipt = req.file ? req.file.filename : null;
  if (!Number.isFinite(amount) || amount < min) {
    if (receipt) fs.unlink(path.join(UPLOAD_DIR, receipt), () => {});
    return fail(res, '/topup', `الحد الأدنى للشحن ${min}$`);
  }
  if (!method) {
    if (receipt) fs.unlink(path.join(UPLOAD_DIR, receipt), () => {});
    return fail(res, '/topup', 'اختر طريقة الدفع.');
  }
  if (!reference) {
    if (receipt) fs.unlink(path.join(UPLOAD_DIR, receipt), () => {});
    return fail(res, '/topup', 'اكتب رقم العملية أو المرجع.');
  }
  if (!receipt) return fail(res, '/topup', 'أرفق صورة إشعار التحويل.');
  // Serverless has no persistent disk: keep the receipt bytes in the database
  // so the admin can still open the receipt after a cold start.
  let photoData = null;
  if (SERVERLESS) {
    try {
      photoData = fs.readFileSync(path.join(UPLOAD_DIR, receipt)).toString('base64');
      fs.unlink(path.join(UPLOAD_DIR, receipt), () => {});
    } catch (err) { console.error('[receipt]', err.message); }
  }
  const created = await run(
    'INSERT INTO deposits (user_id, amount, method, reference, note, photo_path, photo_data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    req.user.id, amount, method, reference, 'إيداع من الموقع', receipt, photoData
  );
  ok(res, '/topup', 'تم إرسال طلب الشحن مع صورة الإشعار. سيُضاف الرصيد بعد المراجعة.');
  storeBot().notifyDeposit(created.lastInsertRowid).catch(err =>
    console.error('[deposit notify]', err.message));
}));

// ---------- admin ----------

app.get('/admin', requireAdmin, wrap(async (req, res) => {
  const stats = {
    orders: Number((await get('SELECT COUNT(*) c FROM orders')).c),
    revenue: Number((await get("SELECT COALESCE(SUM(charge),0) s FROM orders WHERE status != 'Failed'")).s),
    users: Number((await get('SELECT COUNT(*) c FROM users')).c),
    pending_deposits: Number((await get("SELECT COUNT(*) c FROM deposits WHERE status = 'pending'")).c),
  };
  let providerBalance = null;
  try { const b = await tota.fetchBalance(); providerBalance = Number(b.balance); } catch { /* shown as — */ }
  const recent = await all(`SELECT o.*, u.name AS user_name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 10`);
  res.send(views.adminHome(req, { user: req.user, siteName: await SITE(), stats, providerBalance, recent }));
}));

app.get('/admin/orders', requireAdmin, wrap(async (req, res) => {
  const q = str(req.query.q, 80);
  const orders = q
    ? await all(`SELECT o.*, u.name AS user_name FROM orders o JOIN users u ON u.id = o.user_id
        WHERE o.service_name LIKE ? OR o.link LIKE ? OR u.name LIKE ? ORDER BY o.id DESC LIMIT 200`, `%${q}%`, `%${q}%`, `%${q}%`)
    : await all(`SELECT o.*, u.name AS user_name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 200`);
  res.send(views.adminOrders(req, { user: req.user, siteName: await SITE(), orders, q }));
}));

app.post('/admin/orders/:id/refresh', requireAdmin, wrap(async (req, res) => {
  const order = await get('SELECT * FROM orders WHERE id = ?', Number(req.params.id));
  if (!order || !order.provider_order_id) return fail(res, '/admin/orders', 'لا يوجد رقم طلب لدى المزوّد.');
  try {
    const st = await tota.orderStatus(order.provider_order_id);
    await run(`UPDATE orders SET status = ?, start_count = ?, remains = ?, updated_at = datetime('now') WHERE id = ?`,
      String(st.status || order.status), st.start_count == null ? null : String(st.start_count), st.remains == null ? null : String(st.remains), order.id);
    ok(res, '/admin/orders', `تم تحديث الطلب #${order.id}.`);
  } catch (err) {
    fail(res, '/admin/orders', `تعذّر التحديث: ${err.message}`);
  }
}));

app.get('/admin/deposits', requireAdmin, wrap(async (req, res) => {
  const deposits = await all(`SELECT d.*, u.name AS user_name, u.email AS user_email FROM deposits d
    JOIN users u ON u.id = d.user_id ORDER BY CASE WHEN d.status = 'pending' THEN 0 ELSE 1 END, d.id DESC LIMIT 200`);
  res.send(views.adminDeposits(req, { user: req.user, siteName: await SITE(), deposits }));
}));

app.post('/admin/deposits/:id/approve', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const d = await get("SELECT * FROM deposits WHERE id = ? AND status = 'pending'", id);
  if (!d) return fail(res, '/admin/deposits', 'الطلب غير موجود أو تمت مراجعته.');
  await batch([
    { sql: "UPDATE deposits SET status = 'approved', reviewed_at = datetime('now') WHERE id = ?", args: [id] },
    { sql: 'UPDATE users SET balance = balance + ? WHERE id = ?', args: [d.amount, d.user_id] },
  ]);
  ok(res, '/admin/deposits', `تمت الموافقة وإضافة ${views.money(d.amount)}.`);
}));

app.post('/admin/deposits/:id/reject', requireAdmin, wrap(async (req, res) => {
  const d = await get("SELECT * FROM deposits WHERE id = ? AND status = 'pending'", Number(req.params.id));
  if (!d) return fail(res, '/admin/deposits', 'الطلب غير موجود أو تمت مراجعته.');
  await run("UPDATE deposits SET status = 'rejected', reviewed_at = datetime('now') WHERE id = ?", d.id);
  ok(res, '/admin/deposits', `تم رفض الطلب #${d.id}.`);
}));

app.get('/admin/deposits/:id/photo', requireAdmin, wrap(async (req, res) => {
  const d = await get('SELECT photo_path, photo_data FROM deposits WHERE id = ?', Number(req.params.id));
  if (!d) return res.status(404).send('Not found');
  if (d.photo_data) {
    res.type(path.extname(d.photo_path || '') || '.jpg');
    return res.send(Buffer.from(d.photo_data, 'base64'));
  }
  if (!d.photo_path) return res.status(404).send('Not found');
  const file = path.join(UPLOAD_DIR, path.basename(d.photo_path));
  if (!fs.existsSync(file)) return res.status(404).send('Not found');
  res.sendFile(file);
}));

app.get('/admin/users', requireAdmin, wrap(async (req, res) => {
  const users = await all('SELECT * FROM users ORDER BY id DESC LIMIT 500');
  res.send(views.adminUsers(req, { user: req.user, siteName: await SITE(), users }));
}));

app.post('/admin/users/:id/balance', requireAdmin, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  const id = Number(req.params.id);
  if (!Number.isFinite(amount) || amount === 0) return fail(res, '/admin/users', 'اكتب مبلغاً غير صفري.');
  const user = await get('SELECT * FROM users WHERE id = ?', id);
  if (!user) return fail(res, '/admin/users', 'المستخدم غير موجود.');
  const next = Math.max(0, user.balance + amount);
  await run('UPDATE users SET balance = ? WHERE id = ?', next, id);
  ok(res, '/admin/users', `تم تعديل رصيد ${user.name} إلى ${views.money(next)}.`);
}));

app.get('/admin/services', requireAdmin, wrap(async (req, res) => {
  const category = str(req.query.category, 80);
  const q = str(req.query.q, 80);
  const services = await all(`SELECT * FROM services
    WHERE (? = '' OR category = ?) AND (? = '' OR name LIKE ?)
    ORDER BY category, service_id LIMIT 2000`, category, category, q, `%${q}%`);
  const categories = await all('SELECT DISTINCT category FROM services ORDER BY category');
  const defaultMarkup = await getSetting('default_markup', '20');
  res.send(views.adminServices(req, { user: req.user, siteName: await SITE(), services, categories, category, q, defaultMarkup }));
}));

app.post('/admin/services/:service_id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.service_id);
  const rawMarkup = str(req.body.markup, 10);
  const markup = rawMarkup === '' ? null : Number(rawMarkup);
  if (markup != null && (!Number.isFinite(markup) || markup < -100 || markup > 1000)) {
    return fail(res, '/admin/services', 'الهامش يجب أن يكون رقماً منطقياً.');
  }
  const enabled = req.body.enabled === '0' ? 0 : 1;
  await run('UPDATE services SET markup = ?, enabled = ? WHERE service_id = ?', markup, enabled, id);
  ok(res, '/admin/services', `تم حفظ الخدمة ${id}.`);
}));

app.get('/admin/settings', requireAdmin, wrap(async (req, res) => {
  const settings = {
    site_name: await getSetting('site_name', 'TOTA SMM'),
    default_markup: await getSetting('default_markup', '20'),
    min_deposit: await getSetting('min_deposit', '5'),
    star_usd: await getSetting('star_usd', '0.01'),
    topup_methods: await getSetting('topup_methods', 'كريمي كاش، جوالي، تحويل بنكي، USDT'),
    topup_wallets: await getSetting('topup_wallets', ''),
    services_synced_at: await getSetting('services_synced_at', ''),
  };
  let providerBalance = null;
  try { providerBalance = Number((await tota.fetchBalance()).balance); } catch { /* ignore */ }
  res.send(views.adminSettings(req, {
    user: req.user, siteName: await SITE(), settings, providerBalance,
    walletsText: walletsText(parseWallets(settings.topup_wallets)),
    syncError: req.query.err || null,
  }));
}));

app.post('/admin/settings', requireAdmin, wrap(async (req, res) => {
  const siteName = str(req.body.site_name, 60);
  const markup = Number(req.body.default_markup);
  const minDeposit = Number(req.body.min_deposit);
  if (!siteName) return fail(res, '/admin/settings', 'اسم الموقع مطلوب.');
  if (!Number.isFinite(markup) || markup < 0 || markup > 1000) return fail(res, '/admin/settings', 'الهامش غير صحيح.');
  if (!Number.isFinite(minDeposit) || minDeposit < 0) return fail(res, '/admin/settings', 'الحد الأدنى غير صحيح.');
  const starUsd = Number(req.body.star_usd);
  if (!Number.isFinite(starUsd) || starUsd <= 0 || starUsd > 10) return fail(res, '/admin/settings', 'سعر النجمة غير صحيح.');
  await setSetting('site_name', siteName);
  await setSetting('default_markup', markup);
  await setSetting('min_deposit', minDeposit);
  await setSetting('star_usd', starUsd);
  await setSetting('topup_methods', str(req.body.topup_methods, 300));
  const wallets = walletsText(parseWallets(req.body.topup_wallets || ''));
  await setSetting('topup_wallets', wallets);
  ok(res, '/admin/settings', 'تم حفظ الإعدادات.');
}));

app.post('/admin/sync-services', requireAdmin, wrap(async (req, res) => {
  try {
    const out = await tota.syncServices();
    ok(res, '/admin/services', `تمت مزامنة ${out.synced} خدمة (الإجمالي ${out.stored}).`);
  } catch (err) {
    fail(res, '/admin/settings', `فشلت المزامنة: ${err.message}`);
  }
}));

// Telegram webhook (serverless mode). Long polling cannot run on Netlify, so
// the store bot is driven by Telegram POSTing updates here.
app.post('/telegram/webhook', wrap(async (req, res) => {
  const secret = process.env.WEBHOOK_SECRET || '';
  if (secret && req.get('x-telegram-bot-api-secret-token') !== secret) {
    return res.status(403).send('Forbidden');
  }
  try {
    await storeBot().handleUpdate(req.body || {});
  } catch (err) {
    console.error('[bot] update failed:', err.message);
  }
  res.json({ ok: true });
}));

app.get('/healthz', (req, res) => res.json({
  ok: true,
  time: nowIso(),
  db: db.mode,
  // A serverless run without a real database URL writes to /tmp and loses
  // everything between cold starts — surfaced here so it is caught immediately.
  ephemeral: SERVERLESS && db.mode === 'file',
  bot: Boolean(process.env.STORE_BOT_TOKEN),
  provider: Boolean(process.env.TOTA_API_KEY),
}));

app.use(async (err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).send(views.page(req, {
    title: 'خطأ', user: req.user || null, siteName: await SITE().catch(() => 'TOTA SMM'),
    body: '<section class="auth-card"><h1>حدث خطأ</h1><p class="muted">حاول مرة أخرى، أو استخدم /reset في المحادثة.</p></section>',
  }));
});

app.use((req, res) => res.status(404).send('Not found'));

// ---------- bootstrap ----------

async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const existing = await get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (existing) {
    await run('UPDATE users SET is_admin = 1 WHERE id = ?', existing.id);
    return;
  }
  await run('INSERT INTO users (email, name, password_hash, is_admin) VALUES (?, ?, ?, 1)',
    email.toLowerCase(), process.env.ADMIN_NAME || 'Admin', auth.hashPassword(password));
  console.log('[bootstrap] admin created:', email);
}

async function ensureServices() {
  const row = await get('SELECT COUNT(*) c FROM services');
  if (Number(row.c) > 0) return;
  try {
    const out = await tota.syncServices();
    console.log('[bootstrap] services synced:', out.synced);
  } catch (err) {
    console.error('[bootstrap] service sync failed:', err.message);
  }
}

let readyPromise = null;
// Runs once per process: schema, admin account, first service sync. Called by
// main() in server mode and by the Netlify function on every cold start.
function withTimeout(promise, ms) {
  let timer;
  const guard = new Promise(resolve => { timer = setTimeout(resolve, ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function ensureReady() {
  return (readyPromise ||= (async () => {
    await init();
    await ensureAdmin();
    // Lambda freezes the process the moment the response is sent, so a
    // fire-and-forget sync would never finish on a cold start. Await it, but
    // only briefly: a slow provider must not hang the first page view. If it
    // is cut off, the next cold start (services still empty) tries again, and
    // the admin always has the manual sync button.
    const bootstrapServices = SERVERLESS ? withTimeout(ensureServices(), 7000) : ensureServices();
    await bootstrapServices.catch(err => console.error('[bootstrap]', err.message));
    // Register the Telegram webhook once per deployment (serverless only:
    // there is no long-running process to keep polling alive).
    if (SERVERLESS && PUBLIC_BASE) {
      const marker = await getSetting('telegram_webhook_url', '');
      if (marker !== PUBLIC_BASE) {
        await storeBot().startWebhook(PUBLIC_BASE);
        await setSetting('telegram_webhook_url', PUBLIC_BASE);
      }
    }
  })());
}

async function main() {
  await ensureReady();
  app.listen(PORT, () => console.log(`[tota-smm] listening on http://localhost:${PORT}`));
  if (String(process.env.BOT_MODE || 'polling').toLowerCase() === 'webhook') {
    storeBot().startWebhook(PUBLIC_BASE).catch(err => console.error('[bot]', err.message));
  } else {
    storeBot().start().catch(err => console.error('[bot]', err.message));
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[tota-smm] startup failed:', err);
    process.exit(1);
  });
}

module.exports = { app, ensureReady };
