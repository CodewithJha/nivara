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

const views = {
  async dashboard() {
    const d = await api('/dashboard');
    const p = d.pending.orders, hp = d.highPriority, th = d.supplierThreshold, f = d.forecast;
    const worth = d.opportunities.filter(o => o.significant), small = d.opportunities.filter(o => !o.significant);
    const restockJob = r => ({ level: LEVEL[r.risk], to: 'p-' + r.sku, title: `Restock ${r.name}${r.risk === 'medium' ? ' this week' : ''}`,
      facts: `${restockWhy(r)}${r.reorderQty ? ` Order ${r.reorderQty}.` : ''}`,
      acts: `<button class="btn primary" onclick="send(${esc(JSON.stringify(`Why is ${r.name} at risk?`))});go('ask')">Ask why</button><a class="btn" href="#forecast">See the forecast</a>` });
    const orderJob = o => ({ level: FLAG[o.flag], to: 'o-' + o._id, title: `Deliver ${firstName(o.customerName)}'s order`,
      facts: `${dueWords(o, d.date).replace(/<[^>]+>/g, '')}. ${orderName(o._id)}: ${itemList(o)}. ${inr(o.total)}.`,
      acts: `${deliverBtn(o, 'btn primary')}<a class="btn" href="#orders">All orders</a>` });
    const jobs = [
      ...p.filter(o => o.flag === 'overdue').map(orderJob),
      ...hp.filter(r => r.risk === 'high').map(restockJob),
      ...p.filter(o => o.flag && o.flag !== 'overdue').map(orderJob),
      ...hp.filter(r => r.risk === 'medium').map(restockJob),
      ...worth.map(o => ({ level: 'light', to: 's-' + o.sku, title: `Pay less for ${o.name}`,
        facts: `${o.best.supplier} sells it at ${inr(o.best.unitCost)}. You pay ${inr(o.currentCost)} at ${o.currentSupplier}. That's ${inr(o.savingPerUnit)} less a unit (${o.savingPercent}%).`,
        acts: '<a class="btn primary" href="#suppliers">Compare suppliers</a>' })),
    ];
    const top = jobs[0], tapPlates = matchMedia('(min-width: 900px)').matches; // phone plates are too thin to tap; the rows carry the jump
    const count = Object.entries(Object.groupBy(jobs, j => j.level));
    return `<section class="load bleed" aria-label="Today's load">
      <div class="words"><p class="date">${esc(new Date(d.date + 'T00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
      <p class="tally">${count.length ? count.map(([lvl, js]) => `<span>${js.length} <span class="k">${WEIGHT[lvl]}</span></span>`).join('') : 'Empty bar. Nothing to lift today.'}</p></div>
      <div class="barbell"><span class="shaft" aria-hidden="true"></span><span class="collar" aria-hidden="true"></span>
        <div class="plates">${jobs.map((j, i) => tapPlates
          ? `<button class="plate ${j.level}" style="--i:${i}" aria-label="${esc(j.title)}, ${WEIGHT[j.level]}" title="${esc(j.title)}" onclick="go('${esc(j.to)}')"></button>`
          : `<span class="plate ${j.level}" style="--i:${i}" aria-hidden="true"></span>`).join('')}</div>
        <span class="clip" aria-hidden="true"></span><span class="sleeve" aria-hidden="true"></span></div>
      ${d.demo ? '<p class="demo">Sample shop data (seeded, marked demo). Your real products and orders in MongoDB replace it.</p>' : ''}
    </section>
    ${top ? `<section class="first bleed ${top.level}" aria-labelledby="job">
      <p class="kick">${cap(WEIGHT[top.level])} <span>· ${jobs.length === 1 ? 'your one job today' : `first of ${jobs.length} jobs today`}</span></p>
      <h1 id="job">${esc(top.title)}</h1>
      <p class="facts">${esc(top.facts)}</p>
      <div class="acts">${top.acts}</div></section>`
    : `<section class="first bleed clear"><h1 id="job">Nothing needs you today.</h1><p class="facts">No late orders, nothing about to run out, no cheaper quote worth switching for.</p></section>`}
    <div class="day"><div>
      <section class="sec" id="deliver"><h2>Deliver <span class="n">${p.length}</span></h2>
        ${p.length ? `<ul class="rows">${p.map(o => orderRow(o, d.date)).join('')}</ul>` : '<p class="empty">No orders waiting. Paste new ones from WhatsApp or Instagram on <a href="#orders">Orders</a>.</p>'}</section>
      <section class="sec" id="restock"><h2>Restock <span class="n">${hp.length}</span></h2>
        ${hp.length ? `<ul class="rows">${hp.map(r => row({ id: 'p-' + r.sku, level: LEVEL[r.risk], name: esc(r.name),
          why: `${esc(restockWhy(r))} ${r.demand7} expected to sell in 7 days.`, fig: r.reorderQty ? `<b>${r.reorderQty}</b><span>to order</span>` : '' })).join('')}</ul>` : '<p class="empty">Nothing runs out this week.</p>'}
        <p class="note">${methodNote(f.method)} ${f.date !== d.date ? `Forecast from ${esc(day(f.date))}. Refresh it on <a href="#forecast">Forecast</a>.` : `${esc(f.model ?? '')} · ${esc(day(f.date))}`}</p></section>
      <section class="sec" id="save"><h2>Pay less <span class="n">${worth.length}</span></h2>
        <p class="lede">From the quotes you stored. A quote counts when it saves at least ${inr(th.rupees)} and ${th.percent}% a unit.</p>
        ${worth.length ? `<ul class="rows">${worth.map(o => row({ id: 's-' + o.sku, level: 'light', name: esc(o.name),
          why: `${esc(o.best.supplier)} at ${inr(o.best.unitCost)}. You pay ${inr(o.currentCost)} at ${esc(o.currentSupplier)}.`,
          fig: `<b>${inr(o.savingPerUnit)}</b><span>less a unit · ${o.savingPercent}%</span>` })).join('')}</ul>` : '<p class="empty">Your suppliers are already the cheapest you have quotes for.</p>'}
        ${small.length ? `<p class="note">Too small to count: ${esc(small.map(o => `${o.name} (${inr(o.savingPerUnit)}, ${o.savingPercent}%)`).join('; '))}.</p>` : ''}
        ${d.opportunities.some(o => o.skippedBlocked.length) ? `<p class="note">Left out because you blocked them: ${esc([...new Set(d.opportunities.flatMap(o => o.skippedBlocked))].join(', '))}.</p>` : ''}
        ${d.livePrices.length ? `<h3 class="h2 sec">Online prices</h3>${table([['Product', r => esc(r.name), 'lead'], ['Cheapest listing', r => r.cheapest ? `${inr(r.cheapest.price)} · <a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.sourceDomain)}</a>` : '<span class="quiet">No usable listings</span>', 'num'], ['Checked', r => esc(when(r.checkedAt)), 'num']], d.livePrices)}
          <p class="note">Google Shopping via SerpApi, refreshed by the morning workflow. These are retail listings: check the pack size before comparing with your cost.</p>`
        : `<p class="note">${d.serpConfigured ? 'Online prices: nothing fetched yet. Make a fresh brief to fetch them.' : 'Online prices are off (no SerpApi key). Showing stored quotes only.'}</p>`}</section>
    </div>
    <aside>
      ${askBox(['What should I restock?', 'Show my pending orders.', 'What sold the most?', 'What should I focus on today?'])}
      <section class="sec brief"><h2>${d.brief?.date === d.date ? 'Morning brief' : 'Latest brief'}</h2>
        ${d.brief ? `<p class="note">${esc(when(d.brief.createdAt))} · ${d.brief.by === 'template+gemma' ? 'facts from the database, first line summarised by Gemma' : d.brief.by === 'gemma' ? 'written by Gemma (older brief)' : 'facts from the database (no Gemma summary)'}</p><pre class="sec-gap">${esc(d.brief.text)}</pre>` : '<p class="empty">No brief yet. One is made every morning at 8, or make one now.</p>'}
        <div class="acts"><button class="btn" onclick="runWf('dailyBriefWorkflow', this)">Make a fresh brief</button><span class="small quiet" id="wfout" role="status"></span></div></section>
    </aside></div>`;
  },
