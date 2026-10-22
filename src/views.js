'use strict';

// Sell rate = provider rate plus markup (per-service override or the site default).
// Computed synchronously here so views stay pure; the routes pass defaultMarkup in.
function sellRate(service, defaultMarkup) {
  const markup = service.markup == null ? Number(defaultMarkup) || 0 : Number(service.markup);
  return Number(service.rate) * (1 + markup / 100);
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n) {
  const v = Number(n) || 0;
  return '$' + v.toFixed(v < 1 ? 4 : 2);
}

function flash(req) {
  const ok = req.query.ok ? `<div class="flash ok">${esc(req.query.ok)}</div>` : '';
  const err = req.query.err ? `<div class="flash err">${esc(req.query.err)}</div>` : '';
  return ok + err;
}

function layout({ title, user, siteName, body, active = '', admin = false }) {
  admin = admin || Boolean(user && user.is_admin);
  const navLink = (href, label, key) =>
    `<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
  const authArea = user
    ? `<span class="bal">${money(user.balance)}</span>
       <a href="/account" class="nav-user">${esc(user.name)}</a>
       <form method="post" action="/logout" class="inline"><button class="link-btn">خروج</button></form>`
    : `<a href="/login">دخول</a><a href="/register" class="btn small">حساب جديد</a>`;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#ffffff">
<meta name="description" content="${esc(siteName)} — خدمات متابعين ومشاهدات وتفاعل لجميع منصات التواصل. طلب فوري من رصيدك.">
<title>${esc(title)} · ${esc(siteName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css?v=3">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚀</text></svg>">
</head>
<body>
<header class="topbar">
  <div class="wrap nav">
    <a class="logo" href="/"><span class="dot"></span>${esc(siteName)}</a>
    <nav class="links">
      ${navLink('/', 'الخدمات', 'home')}
      ${navLink('/account', 'حسابي', 'account')}
      ${navLink('/topup', 'شحن الرصيد', 'topup')}
      ${admin ? navLink('/admin', 'لوحة التحكم', 'admin') : ''}
    </nav>
    <div class="auth">${authArea}</div>
  </div>
</header>
<main class="wrap">
${flash({ query: {} })}
${body}
</main>
<footer class="wrap foot">
  <span>${esc(siteName)} — خدمات وسائل التواصل الاجتماعي</span>
  <span>الأسعار بالدولار الأمريكي · تُخصم من رصيدك</span>
</footer>
<script src="/app.js?v=2"></script>
</body>
</html>`;
}

// flash is rendered inside pages that have req; keep layout simple
function page(req, opts) {
  return layout(opts).replace('<main class="wrap">\n', '<main class="wrap">\n' + flash(req));
}

function authPage({ user, siteName, mode, error }) {
  const isLogin = mode === 'login';
  return layout({
    title: isLogin ? 'دخول' : 'حساب جديد', user, siteName, active: '',
    body: `
<section class="auth-card">
  <h1>${isLogin ? 'تسجيل الدخول' : 'إنشاء حساب'}</h1>
  <p class="muted">${isLogin ? 'أدخل بريدك وكلمة المرور للمتابعة' : 'أنشئ حسابك وابدأ الطلب خلال دقيقة'}</p>
  ${error ? `<div class="flash err">${esc(error)}</div>` : ''}
  <form method="post" action="${isLogin ? '/login' : '/register'}" class="stack">
    ${isLogin ? '' : '<label>الاسم<input name="name" required maxlength="60" placeholder="اسمك"></label>'}
    <label>البريد الإلكتروني<input type="email" name="email" required placeholder="you@example.com" dir="ltr"></label>
    <label>كلمة المرور<input type="password" name="password" required minlength="6" dir="ltr"></label>
    <button class="btn wide">${isLogin ? 'دخول' : 'إنشاء الحساب'}</button>
  </form>
  <p class="muted center">${isLogin ? 'ما عندك حساب؟ <a href="/register">سجّل الآن</a>' : 'عندك حساب؟ <a href="/login">دخول</a>'}</p>
</section>`
  });
}

function catalogPage(req, { user, siteName, services, categories, category, q, defaultMarkup }) {
  const cards = services.map(s => {
    const rate = sellRate(s, defaultMarkup);
    return `<article class="svc">
      <div class="svc-top"><span class="chip">${esc(s.category)}</span>${s.refill ? '<span class="mini ok">ضمان تعويض</span>' : ''}</div>
      <h3>${esc(s.name)}</h3>
      <div class="svc-meta">
        <span class="price">${money(rate)} <small>/ 1000</small></span>
        <span class="muted">الحد: ${s.min} – ${s.max}</span>
      </div>
      <a class="btn wide" href="/order/${s.service_id}">اطلب الآن</a>
    </article>`;
  }).join('');

  const pills = [`<a class="pill ${!category ? 'on' : ''}" href="/${q ? '?q=' + encodeURIComponent(q) : ''}">الكل</a>`]
    .concat(categories.map(c => `<a class="pill ${category === c.category ? 'on' : ''}" href="/?category=${encodeURIComponent(c.category)}${q ? '&q=' + encodeURIComponent(q) : ''}">${esc(c.category)} <small>${c.count}</small></a>`))
    .join('');

  const total = categories.reduce((a, c) => a + c.count, 0);

  return page(req, {
    title: 'الخدمات', user, siteName, active: 'home',
    body: `
<section class="hero">
  <div>
    <span class="eyebrow">أسرع طرق النمو</span>
    <h1>متابعين، مشاهدات، وتفاعل<br><span class="grad">على كل المنصات</span></h1>
    <p class="muted">اختر الخدمة، ألصق الرابط، وحدد الكمية. الطلب يبدأ فوراً من رصيدك — بدون انتظار موافقة.</p>
    <div class="hero-actions">
      <a class="btn" href="#services">تصفّح الخدمات</a>
      ${user ? `<a class="btn ghost" href="/account">حسابي · ${money(user.balance)}</a>` : '<a class="btn ghost" href="/register">أنشئ حساباً</a>'}
    </div>
    <p class="hero-note">تنفيذ آلي فوري · أسعار واضحة بالدولار · دعم عبر تيليجرام</p>
  </div>
  <div class="stats">
    <div><b>${total}</b><span>خدمة متاحة</span></div>
    <div><b>${categories.length}</b><span>منصة</span></div>
    <div><b>24/7</b><span>معالجة آلية</span></div>
  </div>
</section>

<section id="services" class="catalog">
  <div class="catalog-head">
    <h2>الخدمات</h2>
    <form class="search" method="get" action="/">
      ${category ? `<input type="hidden" name="category" value="${esc(category)}">` : ''}
      <input name="q" value="${esc(q || '')}" placeholder="ابحث عن خدمة…" aria-label="بحث">
      <button class="btn small">بحث</button>
    </form>
  </div>
  <div class="pills">${pills}</div>
  ${services.length ? `<div class="grid">${cards}</div>` : '<p class="muted empty">لا توجد خدمات مطابقة. جرّب كلمة أخرى أو اختر منصة مختلفة.</p>'}
</section>`
  });
}

function orderPage(req, { user, siteName, service, error, defaultMarkup }) {
  const rate = sellRate(service, defaultMarkup);
  return page(req, {
    title: service.name, user, siteName, active: 'home',
    body: `
<a class="back" href="/">→ كل الخدمات</a>
<section class="order-wrap">
  <div class="order-card">
    <span class="chip">${esc(service.category)}</span>
    <h1>${esc(service.name)}</h1>
    <p class="muted">السعر: <b>${money(rate)}</b> لكل 1000 · الحد الأدنى ${service.min} · الأقصى ${service.max}</p>
    ${error ? `<div class="flash err">${esc(error)}</div>` : ''}
    ${user ? `
    <form method="post" action="/order" class="stack" data-price="${rate}" data-service="${service.service_id}">
      <input type="hidden" name="service_id" value="${service.service_id}">
      <label>الرابط أو المعرّف
        <input name="link" required placeholder="https://…" dir="ltr">
      </label>
      <label>الكمية
        <input name="quantity" type="number" required min="${service.min}" max="${service.max}" value="${service.min}" inputmode="numeric">
      </label>
      <div class="summary">
        <span>التكلفة</span>
        <b id="total">${money(rate * service.min / 1000)}</b>
      </div>
      <div class="summary">
        <span>رصيدك</span>
        <b class="${user.balance <= 0 ? 'bad' : 'good'}">${money(user.balance)}</b>
      </div>
      <button class="btn wide">تأكيد الطلب</button>
    </form>` : `
    <div class="cta-box">
      <p>تحتاج حساباً للطلب. التسجيل يستغرق أقل من دقيقة.</p>
      <a class="btn" href="/register">أنشئ حساباً</a>
      <a class="btn ghost" href="/login">دخول</a>
    </div>`}
  </div>
  <aside class="side-card">
    <h3>كيف يعمل؟</h3>
    <ol class="steps">
      <li>ألصق رابط المنشور أو الحساب.</li>
      <li>حدد الكمية — السعر يُحسب فوراً.</li>
      <li>يُخصم المبلغ من رصيدك ويبدأ التنفيذ.</li>
      <li>تابع الحالة من «حسابي».</li>
    </ol>
    <p class="muted small">الطلبات لا تُلغى بعد بدء التنفيذ إلا إذا كانت الخدمة تدعم الإلغاء.</p>
  </aside>
</section>`
  });
}

const STATUS_AR = {
  creating: 'قيد الإنشاء',
  pending: 'قيد الانتظار',
  'in progress': 'جارٍ التنفيذ',
  processing: 'جارٍ التنفيذ',
  completed: 'مكتمل',
  partial: 'مكتمل جزئياً',
  canceled: 'ملغي',
  cancelled: 'ملغي',
  failed: 'فشل',
  refunded: 'مُعاد',
  approved: 'مقبول',
  rejected: 'مرفوض',
};

function statusBadge(status) {
  const s = String(status || '').toLowerCase().trim();
  let cls = 'wait';
  if (s.includes('complet')) cls = 'done';
  else if (s.includes('progress') || s.includes('process')) cls = 'run';
  else if (s.includes('cancel') || s.includes('fail') || s.includes('refund') || s.includes('reject')) cls = 'fail';
  else if (s.includes('partial')) cls = 'part';
  else if (s.includes('approv')) cls = 'done';
  const label = STATUS_AR[s] || status || '—';
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function accountPage(req, { user, siteName, orders, deposits, telegram = null }) {
  const rows = orders.map(o => `<tr>
    <td>#${o.id}</td>
    <td class="ellipsis" title="${esc(o.service_name)}">${esc(o.service_name)}</td>
    <td class="ellipsis" dir="ltr">${esc(o.link)}</td>
    <td>${o.quantity}</td>
    <td>${money(o.charge)}</td>
    <td>${statusBadge(o.status)}</td>
    <td>${o.start_count != null ? esc(o.start_count) : '—'} / ${o.remains != null ? esc(o.remains) : '—'}</td>
    <td><form method="post" action="/account/orders/${o.id}/refresh" class="inline"><button class="link-btn">تحديث</button></form></td>
  </tr>`).join('');
  const depRows = deposits.map(d => `<tr>
    <td>#${d.id}</td><td>${money(d.amount)}</td><td>${esc(d.method)}</td>
    <td>${statusBadge(d.status)}</td><td>${esc(d.created_at)}</td>
  </tr>`).join('');

  return page(req, {
    title: 'حسابي', user, siteName, active: 'account',
    body: `
<section class="dash-head">
  <div>
    <span class="eyebrow">حسابي</span>
    <h1>أهلاً، ${esc(user.name)}</h1>
    ${user.is_admin ? '<p class="muted small">حساب إدارة — <a href="/admin">افتح لوحة التحكم</a></p>' : ''}
  </div>
  <div class="balance-card">
    <span>الرصيد المتاح</span>
    <b>${money(user.balance)}</b>
    <a class="btn small" href="/topup">شحن الرصيد</a>
  </div>
</section>

${telegram ? `<div class="card-pad tg-card">
  <h3>الدفع بنجوم تيليجرام</h3>
  ${telegram.linked
    ? `<p>حسابك مرتبط${telegram.username ? ` بـ <b>@${esc(telegram.username)}</b>` : ''}. افتح البوت واضغط «شحن بالنجوم».</p>
       <a class="btn small" href="https://t.me/${esc(telegram.bot)}?start=topup" target="_blank" rel="noopener">فتح @${esc(telegram.bot)}</a>`
    : `<p>افتح البوت <a href="https://t.me/${esc(telegram.bot)}" target="_blank" rel="noopener">@${esc(telegram.bot)}</a> وأرسل:</p>
       <p><code>/link ${esc(telegram.code)}</code></p>
       <p class="muted small">الكود صالح 24 ساعة. بعد الربط تقدر تشحن رصيدك بالنجوم مباشرة من داخل تيليجرام.</p>`}
</div>` : ''}

<h2 class="sec-title">طلباتي</h2>
${orders.length ? `<div class="table-wrap"><table>
  <thead><tr><th>#</th><th>الخدمة</th><th>الرابط</th><th>الكمية</th><th>التكلفة</th><th>الحالة</th><th>البداية / المتبقي</th><th></th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>` : '<p class="muted empty">ما عندك طلبات بعد. اختر خدمة من <a href="/">القائمة</a>.</p>'}

<h2 class="sec-title">طلبات الشحن</h2>
${deposits.length ? `<div class="table-wrap"><table>
  <thead><tr><th>#</th><th>المبلغ</th><th>الطريقة</th><th>الحالة</th><th>التاريخ</th></tr></thead>
  <tbody>${depRows}</tbody>
</table></div>` : '<p class="muted empty">لا توجد طلبات شحن.</p>'}`
  });
}

function topupPage(req, { user, siteName, methods, wallets = [], minDeposit, botUsername = '' }) {
  const names = wallets.length ? wallets.map(w => w.name) : methods.split(/[,،]/).map(m => m.trim()).filter(Boolean);
  const list = wallets.length ? wallets : names.map(name => ({ name, number: '', holder: '' }));
  const cards = list.map((w, i) => {
    const raw = w.number || '';
    const isUrl = /^https?:\/\//i.test(raw);
    const number = isUrl
      ? `<span class="pay-number" dir="ltr">${esc(raw.replace(/^https?:\/\//i, ''))}</span>`
      : raw
        ? `<span class="pay-number"${/^[\d+\s-]+$/.test(raw) ? ' dir="ltr"' : ''}>${esc(raw)}</span>`
        : '<span class="pay-number muted">اطلب الرقم من الدعم</span>';
    const initial = (w.name || '؟').trim().charAt(0);
    return `<label class="pay-card" data-name="${esc(w.name)}" data-number="${esc(raw)}" data-holder="${esc(w.holder || '')}" style="--i:${i}">
      <input type="radio" name="method" value="${esc(w.name)}" ${i === 0 ? 'checked' : ''} required>
      <span class="pay-body">
        <span class="pay-badge" aria-hidden="true">${esc(initial)}</span>
        <span class="pay-name">${esc(w.name)}</span>
        ${number}
        ${w.holder ? `<span class="pay-holder">${esc(w.holder)}</span>` : ''}
        <span class="pay-check" aria-hidden="true">✓</span>
      </span>
    </label>`;
  }).join('');
  const first = list[0] || { name: '', number: '', holder: '' };
  const amountChips = [5, 10, 25, 50, 100]
    .filter(v => v >= Number(minDeposit))
    .map(v => `<button type="button" class="amt-chip" data-amount="${v}">$${v}</button>`)
    .join('');
  const botLink = botUsername
    ? `<a class="stars-link" href="https://t.me/${esc(botUsername)}?start=topup" target="_blank" rel="noopener">
        <span class="stars-ico" aria-hidden="true">★</span>
        <span><strong>شحن فوري بنجوم تيليجرام</strong><span class="small muted">عبر @${esc(botUsername)} — يضاف الرصيد فوراً</span></span>
        <span class="stars-arrow" aria-hidden="true">←</span>
      </a>`
    : '';
  return page(req, {
    title: 'شحن الرصيد', user, siteName, active: 'topup',
    body: `
<a class="back" href="/account">→ حسابي</a>
<section class="topup-hero">
  <div class="topup-hero-text">
    <span class="eyebrow">شحن الرصيد</span>
    <h1>اشحن رصيدك في دقيقة</h1>
    <p class="muted">اختر المحفظة، حوّل المبلغ، وأرسل صورة الإشعار — نراجعه ونضيف الرصيد.</p>
  </div>
  <div class="balance-pill">
    <span class="bp-label">رصيدك الحالي</span>
    <strong class="bp-value">${money(user.balance)}</strong>
  </div>
</section>

<form method="post" action="/topup" enctype="multipart/form-data" class="topup-form" data-topup>
  <div class="step step-pay" id="step-1">
    <div class="step-head">
      <span class="step-num">١</span>
      <div><h3>اختر طريقة الدفع</h3><p class="muted small">اضغط على المحفظة اللي بتحوّل منها.</p></div>
    </div>
    <div class="pay-grid">${cards}</div>
  </div>

  <div class="step" id="step-2">
    <div class="step-head">
      <span class="step-num">٢</span>
      <div><h3>حوّل المبلغ وسجّل رقم العملية</h3><p class="muted small">حوّل على الرقم التالي، ثم عبّي البيانات.</p></div>
    </div>
    <div class="transfer-panel">
      <span class="transfer-badge" data-t-badge aria-hidden="true">${esc((first.name || '؟').trim().charAt(0))}</span>
      <div class="transfer-info">
        <span class="transfer-name" data-t-name>${esc(first.name)}</span>
        ${/^https?:\/\//i.test(first.number || '')
          ? `<a class="transfer-number" data-t-number dir="ltr" href="${esc(first.number)}" target="_blank" rel="noopener">${esc(first.number.replace(/^https?:\/\//i, ''))}</a>`
          : `<span class="transfer-number" data-t-number dir="ltr">${esc((first.number || '').replace(/^https?:\/\//i, '')) || '—'}</span>`}
        <span class="transfer-holder" data-t-holder>${esc(first.holder || '')}</span>
      </div>
      <button type="button" class="copy-btn" data-copy="${esc(first.number || '')}">نسخ الرقم</button>
    </div>

    <label class="field">المبلغ (USD)
      <input name="amount" type="number" min="${esc(minDeposit)}" step="0.01" required placeholder="${esc(minDeposit)}" inputmode="decimal">
    </label>
    ${amountChips ? `<div class="amt-chips">${amountChips}</div>` : ''}

    <label class="field">رقم العملية / المرجع
      <input name="reference" required placeholder="مثال: 88291034" dir="ltr" inputmode="numeric">
    </label>
  </div>

  <div class="step" id="step-3">
    <div class="step-head">
      <span class="step-num">٣</span>
      <div><h3>أرفق صورة الإشعار</h3><p class="muted small">صورة واضحة فيها المبلغ ورقم العملية.</p></div>
    </div>
    <label class="dropzone" data-dropzone>
      <input name="photo" type="file" accept="image/jpeg,image/png,image/webp" required>
      <span class="dz-icon" aria-hidden="true">⇪</span>
      <span class="dz-title">اسحب الصورة هنا أو اضغط للاختيار</span>
      <span class="muted small">JPG · PNG · WebP — حتى 8 ميجا</span>
      <img class="dz-preview" alt="معاينة الإشعار" hidden>
    </label>
  </div>

  <button class="btn wide submit-btn" type="submit">
    <span class="btn-label">إرسال طلب الشحن</span>
    <span class="btn-spin" aria-hidden="true"></span>
  </button>
  <p class="muted small center">الحد الأدنى للشحن ${money(minDeposit)} · الرصيد يضاف بعد التحقق من الإشعار.</p>
</form>

${botLink}
<div class="toast" data-toast role="status" aria-live="polite"></div>`
  });
}

function adminLayout(req, { user, siteName, active, title, body }) {
  const link = (href, label, key) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  return page(req, {
    title, user, siteName, active: 'admin',
    body: `
<section class="admin">
  <aside class="admin-nav">
    <div class="admin-title">لوحة التحكم</div>
    ${link('/admin', 'نظرة عامة', 'home')}
    ${link('/admin/orders', 'الطلبات', 'orders')}
    ${link('/admin/deposits', 'الشحن', 'deposits')}
    ${link('/admin/users', 'المستخدمون', 'users')}
    ${link('/admin/services', 'الخدمات', 'services')}
    ${link('/admin/settings', 'الإعدادات', 'settings')}
  </aside>
  <div class="admin-main">
    <h1>${esc(title)}</h1>
    ${body}
  </div>
</section>`
  });
}

function adminHome(req, { user, siteName, stats, providerBalance, recent }) {
  const rows = recent.map(o => `<tr>
    <td>#${o.id}</td><td>${esc(o.user_name || '')}</td>
    <td class="ellipsis">${esc(o.service_name)}</td><td>${money(o.charge)}</td>
    <td>${statusBadge(o.status)}</td><td>${esc(o.created_at)}</td>
  </tr>`).join('');
  return adminLayout(req, {
    user, siteName, active: 'home', title: 'نظرة عامة',
    body: `
<div class="kpis">
  <div class="kpi"><span>الطلبات</span><b>${stats.orders}</b></div>
  <div class="kpi"><span>الإيراد</span><b>${money(stats.revenue)}</b></div>
  <div class="kpi"><span>المستخدمون</span><b>${stats.users}</b></div>
  <div class="kpi"><span>رصيد المزوّد</span><b class="${providerBalance <= 0 ? 'bad' : 'good'}">${providerBalance == null ? '—' : money(providerBalance)}</b></div>
</div>
<div class="admin-actions">
  <form method="post" action="/admin/sync-services" class="inline"><button class="btn small">مزامنة الخدمات من المزوّد</button></form>
  <a class="btn small ghost" href="/admin/deposits">مراجعة طلبات الشحن (${stats.pending_deposits})</a>
</div>
<h2 class="sec-title">أحدث الطلبات</h2>
${recent.length ? `<div class="table-wrap"><table>
<thead><tr><th>#</th><th>المستخدم</th><th>الخدمة</th><th>المبلغ</th><th>الحالة</th><th>التاريخ</th></tr></thead>
<tbody>${rows}</tbody></table></div>` : '<p class="muted empty">لا طلبات بعد.</p>'}`
  });
}

function adminOrders(req, { user, siteName, orders, q }) {
  const rows = orders.map(o => `<tr>
    <td>#${o.id}</td><td>${esc(o.user_name || '')}</td>
    <td class="ellipsis">${esc(o.service_name)}</td>
    <td class="ellipsis" dir="ltr">${esc(o.link)}</td>
    <td>${o.quantity}</td><td>${money(o.charge)}</td>
    <td>${esc(o.provider_order_id || '—')}</td>
    <td>${statusBadge(o.status)}</td>
    <td><form method="post" action="/admin/orders/${o.id}/refresh" class="inline"><button class="link-btn">تحديث</button></form></td>
  </tr>`).join('');
  return adminLayout(req, {
    user, siteName, active: 'orders', title: 'الطلبات',
    body: `
<form class="search" method="get" action="/admin/orders">
  <input name="q" value="${esc(q || '')}" placeholder="ابحث بالخدمة أو الرابط…">
  <button class="btn small">بحث</button>
</form>
${orders.length ? `<div class="table-wrap"><table>
<thead><tr><th>#</th><th>المستخدم</th><th>الخدمة</th><th>الرابط</th><th>الكمية</th><th>المبلغ</th><th>طلب المزوّد</th><th>الحالة</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>` : '<p class="muted empty">لا طلبات مطابقة.</p>'}`
  });
}

function adminDeposits(req, { user, siteName, deposits }) {
  const rows = deposits.map(d => `<tr>
    <td>#${d.id}</td><td>${esc(d.user_name || '')}<br><span class="muted small">${esc(d.user_email || '')}</span></td>
    <td>${money(d.amount)}</td><td>${esc(d.method)}</td><td dir="ltr">${esc(d.reference || '—')}${d.photo_path ? `<br><a class="small" href="/admin/deposits/${d.id}/photo" target="_blank" rel="noopener">صورة الإشعار</a>` : ''}</td>
    <td>${statusBadge(d.status)}</td><td>${esc(d.created_at)}</td>
    <td>${d.status === 'pending' ? `
      <form method="post" action="/admin/deposits/${d.id}/approve" class="inline"><button class="btn tiny">موافقة</button></form>
      <form method="post" action="/admin/deposits/${d.id}/reject" class="inline"><button class="btn tiny ghost">رفض</button></form>` : '—'}</td>
  </tr>`).join('');
  return adminLayout(req, {
    user, siteName, active: 'deposits', title: 'طلبات الشحن',
    body: deposits.length ? `<div class="table-wrap"><table>
<thead><tr><th>#</th><th>المستخدم</th><th>المبلغ</th><th>الطريقة</th><th>المرجع</th><th>الحالة</th><th>التاريخ</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>` : '<p class="muted empty">لا طلبات شحن.</p>'
  });
}

function adminUsers(req, { user, siteName, users }) {
  const rows = users.map(u => `<tr>
    <td>#${u.id}</td><td>${esc(u.name)}</td><td dir="ltr">${esc(u.email)}</td>
    <td>${money(u.balance)}</td><td>${u.is_admin ? 'نعم' : '—'}</td><td>${esc(u.created_at)}</td>
    <td><form method="post" action="/admin/users/${u.id}/balance" class="inline adjust">
      <input name="amount" type="number" step="0.01" placeholder="±" required>
      <button class="btn tiny">تعديل</button>
    </form></td>
  </tr>`).join('');
  return adminLayout(req, {
    user, siteName, active: 'users', title: 'المستخدمون',
    body: `<div class="table-wrap"><table>
<thead><tr><th>#</th><th>الاسم</th><th>البريد</th><th>الرصيد</th><th>مدير</th><th>التسجيل</th><th>تعديل الرصيد</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
  });
}

function adminServices(req, { user, siteName, services, categories, category, q, defaultMarkup }) {
  const rows = services.map(s => `<tr>
    <td>${s.service_id}</td><td class="ellipsis">${esc(s.name)}</td><td>${esc(s.category)}</td>
    <td>${s.rate.toFixed(4)}</td>
    <td>${sellRate(s, defaultMarkup).toFixed(4)}</td>
    <td>${s.min}–${s.max}</td>
    <td>${s.enabled ? '<span class="badge done">مفعّلة</span>' : '<span class="badge fail">موقوفة</span>'}</td>
    <td><form method="post" action="/admin/services/${s.service_id}" class="inline svc-form">
      <input name="markup" type="number" step="1" value="${s.markup == null ? '' : s.markup}" placeholder="هامش %" title="هامش مخصص">
      <select name="enabled"><option value="1" ${s.enabled ? 'selected' : ''}>مفعّلة</option><option value="0" ${!s.enabled ? 'selected' : ''}>موقوفة</option></select>
      <button class="btn tiny">حفظ</button>
    </form></td>
  </tr>`).join('');
  const opts = categories.map(c => `<option ${category === c.category ? 'selected' : ''}>${esc(c.category)}</option>`).join('');
  return adminLayout(req, {
    user, siteName, active: 'services', title: 'الخدمات',
    body: `
<form class="search" method="get" action="/admin/services">
  <select name="category"><option value="">كل المنصات</option>${opts}</select>
  <input name="q" value="${esc(q || '')}" placeholder="ابحث…">
  <button class="btn small">تصفية</button>
</form>
<p class="muted small">عدد الخدمات: ${services.length}. اتركوا «هامش %» فارغاً لاستخدام الهامش الافتراضي.</p>
<div class="table-wrap"><table>
<thead><tr><th>ID</th><th>الخدمة</th><th>المنصة</th><th>سعر المزوّد</th><th>سعر البيع</th><th>الحدود</th><th>الحالة</th><th>تعديل</th></tr></thead>
<tbody>${rows}</tbody></table></div>`
  });
}

function adminSettings(req, { user, siteName, settings, providerBalance, walletsText = '', syncError }) {
  return adminLayout(req, {
    user, siteName, active: 'settings', title: 'الإعدادات',
    body: `
${syncError ? `<div class="flash err">${esc(syncError)}</div>` : ''}
<div class="settings-grid">
  <form method="post" action="/admin/settings" class="stack card-pad">
    <h3>عام</h3>
    <label>اسم الموقع<input name="site_name" value="${esc(settings.site_name)}"></label>
    <label>الهامش الافتراضي (%)<input name="default_markup" type="number" step="0.1" value="${esc(settings.default_markup)}"></label>
    <label>الحد الأدنى للشحن ($)<input name="min_deposit" type="number" step="0.01" value="${esc(settings.min_deposit)}"></label>
    <label>سعر النجمة بالدولار (نجوم تيليجرام)<input name="star_usd" type="number" step="0.001" min="0.001" value="${esc(settings.star_usd)}"></label>
    <label>طرق الشحن (مفصولة بفواصل)<input name="topup_methods" value="${esc(settings.topup_methods)}"></label>
    <label>محافظ الاستلام — سطر لكل محفظة: الاسم | الرقم | صاحب الحساب
      <textarea name="topup_wallets" rows="5" dir="auto" placeholder="جيب | 77xxxxxxx | عبود">${esc(walletsText)}</textarea>
    </label>
    <button class="btn">حفظ</button>
  </form>
  <div class="card-pad">
    <h3>المزوّد</h3>
    <p class="muted small">الرابط والمفتاح يُقرآن من متغيّرات البيئة، لا من هنا.</p>
    <div class="summary"><span>رصيد المزوّد</span><b class="${providerBalance <= 0 ? 'bad' : 'good'}">${providerBalance == null ? '—' : money(providerBalance)}</b></div>
    <div class="summary"><span>آخر مزامنة</span><b>${esc(settings.services_synced_at || 'لم تتم')}</b></div>
    <form method="post" action="/admin/sync-services"><button class="btn small">مزامنة الآن</button></form>
  </div>
</div>`
  });
}

module.exports = {
  esc, money, layout, page,
  authPage, catalogPage, orderPage, accountPage, topupPage,
  adminHome, adminOrders, adminDeposits, adminUsers, adminServices, adminSettings,
};
