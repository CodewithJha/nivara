// Plain JS, no build. Every number rendered here comes from an API response backed by Mongo.
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Number(n ?? 0).toLocaleString('en-IN');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const cap = s => String(s ?? '').replace(/^./, c => c.toUpperCase());
const firstName = s => String(s ?? '').split(' ')[0];
const orderName = id => 'Order ' + (parseInt(String(id).replace(/\D/g, ''), 10) || id);
const day = s => new Date(s + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const when = s => new Date(s).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const daysLate = (due, today) => Math.round((Date.parse(today) - Date.parse(due)) / 864e5);
const itemList = o => o.items.map(i => `${i.quantity}× ${i.name}`).join(', ');

// Job weight, shown as plate colour + thickness (DESIGN.md "The Plate Rule").
const LEVEL = { high: 'heavy', medium: 'mid', low: 'light' };
const FLAG = { overdue: 'heavy', 'due today': 'mid', 'due tomorrow': 'mid', 'no delivery date': 'mid' };
const WEIGHT = { heavy: 'do now', mid: 'this week', light: 'when you can' };
const st = (level, word) => `<span class="st ${level}">${esc(word)}</span>`;
const risk = r => st(LEVEL[r], { high: 'Runs out first', medium: 'This week', low: 'Fine' }[r] ?? r);
const methodNote = m => m === 'tabpfn' ? st('light', 'TabPFN forecast') : st('mid', `${m} forecast (TabPFN unavailable)`);

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const table = (cols, rows, empty = 'Nothing here yet.') => rows.length
  ? `<table><thead><tr>${cols.map(c => `<th scope="col" class="${c[2] ?? ''}">${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${c[2] ?? ''}" data-label="${esc(c[0])}"><div>${c[1](r)}</div></td>`).join('')}</tr>`).join('')}</tbody></table>`
  : `<p class="empty">${empty}</p>`;
const fail = e => `<p class="warn" role="alert">That didn't work: ${esc(e.message)}. Try again, or check <a href="#health">Health</a>.</p>`;
const head = (title, sub = '') => `<header class="head"><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</header>`;
const row = ({ id, level = '', name, why = '', fig = '', act = '', dim }) => `<li class="row${act ? ' has-act' : ''}${dim ? ' dim' : ''}"${id ? ` id="${esc(id)}" tabindex="-1"` : ''}>
  ${level === null ? '<i></i>' : `<i class="edge ${level}" aria-hidden="true"></i>`}<span><span class="name">${name}</span>${why ? `<span class="why">${why}</span>` : ''}</span><span class="fig">${fig}</span><span class="act">${act}</span></li>`;
const deliverBtn = (o, cls = 'btn') => `<button class="${cls}" onclick="deliver('${esc(o._id)}', this)">Mark delivered</button>`;
function dueWords(o, today) {
  if (o.status !== 'pending') return `${cap(esc(o.status))}${o.deliveryDate ? `, was due ${esc(day(o.deliveryDate))}` : ''}`;
  if (o.flag === 'overdue') return `<b class="red">${plural(daysLate(o.deliveryDate, today), 'day')} late</b>, was due ${esc(day(o.deliveryDate))}`;
  if (o.flag === 'no delivery date') return '<b class="amber">No delivery date</b>';
  if (o.flag) return `<b class="amber">${cap(esc(o.flag))}</b>`;
  return `Due ${esc(day(o.deliveryDate))}`;
}
const orderRow = (o, today) => row({
  id: 'o-' + o._id, level: o.status === 'pending' ? FLAG[o.flag] ?? '' : '', dim: o.status !== 'pending',
  name: esc(o.customerName), why: `${orderName(o._id)} · ${esc(itemList(o))}<br>${dueWords(o, today)}`,
  fig: `<b>${inr(o.total)}</b>`, act: o.status === 'pending' ? deliverBtn(o) : '',
});
function restockWhy(r) {
  const left = r.available <= 0 ? `${r.available} left after pending orders` : `${r.available} left of ${r.stock}`;
  const lasts = r.daysOfCover == null ? '' : `, about ${plural(r.daysOfCover, 'day')} of stock`;
  return `${left}${lasts}. ${r.risk === 'high' ? `New stock takes ${plural(r.leadTimeDays, 'day')}.` : 'Runs out this week.'}`;
}
let health = null, flash = '';
