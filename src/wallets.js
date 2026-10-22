// Payment accounts for manual top-ups. Stored as lines of
// "name | number | holder". One entry may span several lines — a bank transfer
// lists the account name, the account number and the bank separately — so any
// line without a "|" continues the previous entry instead of starting a new
// wallet. Parts may also carry a label ("الرقم المصرفي: 079..."), which lets a
// multi-line entry describe several fields inside one card.

const LABEL = /^([^:：]{1,24})[:：]\s*(.+)$/;

function isContinuation(line) {
  return LABEL.test(line) || /^[\d+\s-]+$/.test(line);
}

function parseWallets(text) {
  const blocks = [];
  String(text || '').split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      if (!blocks.length || line.includes('|') || !isContinuation(line)) blocks.push(line);
      else blocks[blocks.length - 1] += ' | ' + line;
    });

  return blocks.map((block) => {
    const parts = block.split('|').map(p => p.trim()).filter(Boolean);
    let name = '';
    let number = '';
    let person = '';
    let bank = '';
    for (const part of parts) {
      // A URL contains "://" — never read its scheme as a field label.
      const m = /:\/\//.test(part) ? null : part.match(LABEL);
      if (!m) {
        if (!name) name = part;
        else if (!number) number = part;
        else person = person ? `${person} — ${part}` : part;
        continue;
      }
      const label = m[1].trim();
      const value = m[2].trim();
      if (/رقم/i.test(label) && !/اسم/i.test(label)) number = value;
      else if (/مصرف|بنك/i.test(label)) bank = value;
      else if (/اسم/i.test(label)) person = value;
      else if (!name) name = label;
      else person = person ? `${person} — ${value}` : value;
    }
    const holder = [person, bank].filter(Boolean).join(' — ');
    return { name, number, holder };
  }).filter(w => w.name);
}

function walletsText(list) {
  return (list || []).map(w => [w.name, w.number, w.holder].filter(Boolean).join(' | ')).join('\n');
}

module.exports = { parseWallets, walletsText };
