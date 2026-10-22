(function () {
  const form = document.querySelector('form[data-price]');
  if (form) {
    const input = form.querySelector('input[name="quantity"]');
    const out = document.getElementById('total');
    const rate = Number(form.dataset.price);
    const fmt = (v) => '$' + v.toFixed(v < 1 ? 4 : 2);
    const update = () => {
      const q = Number(input.value);
      out.textContent = Number.isFinite(q) && q > 0 ? fmt(rate * q / 1000) : '—';
    };
    input.addEventListener('input', update);
    update();
    form.addEventListener('submit', () => {
      const btn = form.querySelector('button');
      if (btn) { btn.disabled = true; btn.textContent = 'جارٍ الإرسال…'; }
    });
  }

  /* ── top-up page ─────────────────────────────────────── */
  const topup = document.querySelector('form[data-topup]');
  if (topup) {
    const toastEl = document.querySelector('[data-toast]');
    let toastTimer;
    const toast = (msg) => {
      if (!toastEl) return;
      toastEl.textContent = msg;
      toastEl.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
    };

    const panel = topup.querySelector('.transfer-panel');
    const tName = topup.querySelector('[data-t-name]');
    const tNumber = topup.querySelector('[data-t-number]');
    const tHolder = topup.querySelector('[data-t-holder]');
    const tBadge = topup.querySelector('[data-t-badge]');
    const copyBtn = topup.querySelector('.copy-btn');

    const showMethod = (card, animate) => {
      if (!card) return;
      const { name = '', number = '', holder = '' } = card.dataset;
      const shown = number.replace(/^https?:\/\//i, '');
      const isUrl = /^https?:\/\//i.test(number);
      if (tName) tName.textContent = name;
      if (tNumber) {
        tNumber.textContent = shown || '—';
        if (isUrl) tNumber.setAttribute('href', number);
        else tNumber.removeAttribute('href');
      }
      if (tHolder) tHolder.textContent = holder;
      if (tBadge) tBadge.textContent = (name.trim().charAt(0) || '؟');
      if (copyBtn) {
        copyBtn.dataset.copy = number;
        copyBtn.textContent = isUrl ? 'نسخ الرابط' : 'نسخ الرقم';
      }
      if (animate && panel) {
        panel.classList.remove('pop');
        void panel.offsetWidth;
        panel.classList.add('pop');
      }
    };

    topup.querySelectorAll('.pay-card input').forEach((input) => {
      input.addEventListener('change', () => showMethod(input.closest('.pay-card'), true));
    });
    showMethod(topup.querySelector('.pay-card input:checked')?.closest('.pay-card'), false);

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const value = copyBtn.dataset.copy || '';
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = value;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        copyBtn.classList.add('done');
        copyBtn.textContent = 'تم النسخ ✓';
        toast('تم النسخ');
        const idle = document.querySelector('.pay-card input:checked')?.closest('.pay-card')?.dataset.number;
        setTimeout(() => {
          copyBtn.classList.remove('done');
          copyBtn.textContent = /^https?:\/\//i.test(idle || '') ? 'نسخ الرابط' : 'نسخ الرقم';
        }, 1800);
      });
    }

    const amountInput = topup.querySelector('input[name="amount"]');
    const chips = [...topup.querySelectorAll('.amt-chip')];
    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        if (amountInput) {
          amountInput.value = chip.dataset.amount;
          amountInput.dispatchEvent(new Event('input'));
        }
        chips.forEach((c) => c.classList.toggle('on', c === chip));
      });
    });
    if (amountInput) {
      amountInput.addEventListener('input', () => {
        chips.forEach((c) => c.classList.toggle('on', c.dataset.amount === amountInput.value));
      });
    }

    const dz = topup.querySelector('[data-dropzone]');
    const photo = topup.querySelector('input[name="photo"]');
    const preview = topup.querySelector('.dz-preview');
    const MAX = 8 * 1024 * 1024;
    if (dz && photo) {
      let objectUrl = null;
      const handleFile = () => {
        const file = photo.files && photo.files[0];
        if (!file) {
          dz.classList.remove('has-file');
          if (preview) { preview.hidden = true; preview.removeAttribute('src'); }
          return;
        }
        if (file.size > MAX) {
          toast('الصورة أكبر من 8 ميجا');
          photo.value = '';
          dz.classList.remove('has-file');
          if (preview) preview.hidden = true;
          return;
        }
        dz.classList.add('has-file');
        if (preview) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = URL.createObjectURL(file);
          preview.src = objectUrl;
          preview.hidden = false;
        }
      };
      photo.addEventListener('change', handleFile);
      ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add('drag');
      }));
      ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('drag')));
      dz.addEventListener('drop', (e) => {
        if (!e.dataTransfer || !e.dataTransfer.files.length) return;
        photo.files = e.dataTransfer.files;
        handleFile();
      });
    }

    topup.addEventListener('submit', () => {
      const btn = topup.querySelector('.submit-btn');
      if (btn) btn.classList.add('loading');
    });
  }

  document.querySelectorAll('form.inline').forEach((f) => {
    f.addEventListener('submit', () => {
      const btn = f.querySelector('button');
      if (btn) btn.disabled = true;
    });
  });
})();
