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

const table = (cols, rows, empty = 'Nothing here yet.') => rows.length
  ? `<table><thead><tr>${cols.map(c => `<th scope="col" class="${c[2] ?? ''}">${c[0]}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => `<td class="${c[2] ?? ''}" data-label="${esc(c[0])}"><div>${c[1](r)}</div></td>`).join('')}</tr>`).join('')}</tbody></table>`
  : `<p class="empty">${empty}</p>`;

// ---------- errors and pending buttons ----------
// One error component for every failed request: plain words from the error kind, a Retry, raw detail folded away.
const OOPS = {
  timeout: 'It took too long to answer.',
  network: "Nivara couldn't be reached. Check your connection.",
  server: 'Something went wrong on the server.',
  request: "Nivara couldn't use that request.",
};
const retries = new Map();
let retrySeq = 0;
function errorBox(e, what, retry) {
  const id = ++retrySeq;
  if (retry) retries.set(id, retry);
  const detail = [e?.status && `HTTP ${e.status}`, e?.detail ?? e?.message].filter(Boolean).join(' · ');
  return `<div class="err" role="alert" data-err="${id}"><p>Couldn't ${esc(what)}. ${OOPS[e?.kind] ?? OOPS.server}</p>
    <div class="acts">${retry ? `<button class="btn" onclick="retryNow(${id})">Retry</button>` : ''}<a href="#health">Check Health</a></div>
    ${detail ? `<details class="note"><summary>Details</summary><pre>${esc(detail)}</pre></details>` : ''}</div>`;
}
function retryNow(id) {
  const fn = retries.get(id);
  retries.delete(id);
  const box = document.querySelector(`[data-err="${id}"]`);
  (box?.closest('.row-err') ?? box)?.remove();
  fn?.();
}
/** Error for an inline action: shown under the button's group, replacing that group's previous error. */
function showError(btn, html) {
  const host = btn.closest('.row') ?? btn.closest('.acts, .field') ?? btn;
  const next = host.nextElementSibling;
  if (next?.matches('.err, .row-err')) next.remove();
  host.insertAdjacentHTML('afterend', host.matches('.row') ? `<li class="row-err">${html}</li>` : html);
}
/** Disables the button and shows `label` while fn runs. */
async function busy(btn, label, fn) {
  const text = btn.textContent;
  btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = text; }
}
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
        <div class="acts"><button class="btn" onclick="runWf('dailyBriefWorkflow', this)">Make a fresh brief</button></div><div id="wfout" aria-live="polite"></div></section>
    </aside></div>`;
  },

  async assistant() {
    setTimeout(() => $('#q')?.focus());
    return head('Ask', 'Ask about stock, orders, suppliers or today. Answers come from your database; every answer links to its trace on Activity.') +
      `<div class="day"><div>${askBox([], false)}</div>
      <aside><section class="sec"><h2>Try asking</h2>${tries(["Give me today's business brief", 'What should I restock?', 'Which products are likely to run out?', 'Why are you recommending this?', 'What did I sell the most this week?', 'Find cheaper suppliers for this product', 'What orders are still pending?', "Remember that I don't buy from Supplier C"])}</section></aside></div>`;
  },

  async orders() {
    const [{ orders }, d] = await Promise.all([api('/orders'), api('/dashboard')]);
    const pending = d.pending.orders, done = orders.filter(o => o.status !== 'pending');
    return head('Orders', `${plural(pending.length, 'order')} to deliver.${orders.some(o => o.demo) ? ' Sample orders (seeded, marked demo).' : ''}`) +
    `<section class="sec"><h2>New order from a chat</h2>
      <p class="lede">Paste the WhatsApp or Instagram message. Gemma reads it, the code checks every product and customer against your records, and nothing is saved until you confirm.</p>
      <label class="lbl" for="otext">Message</label>
      <textarea id="otext" rows="3">Rahul wants 3 chocolate bars and one shaker, deliver tomorrow</textarea>
      <div class="acts gap"><button class="btn primary" onclick="extract(this)">Read the message</button></div>
      <div id="draft" aria-live="polite"></div></section>
    <section class="sec"><h2>To deliver <span class="n">${pending.length}</span></h2>
      ${pending.length ? `<ul class="rows">${pending.map(o => orderRow(o, d.date)).join('')}</ul>` : '<p class="empty">Nothing to deliver. New orders you confirm above land here.</p>'}</section>
    <section class="sec"><h2>Done <span class="n">${done.length}</span></h2>
      ${done.length ? `<ul class="rows">${done.map(o => orderRow(o, d.date)).join('')}</ul>` : '<p class="empty">No delivered orders yet.</p>'}</section>`;
  },

  async inventory() {
    const [{ products }, { suppliers }] = await Promise.all([api('/inventory'), api('/suppliers')]);
    const sup = Object.fromEntries(suppliers.map(s => [s._id, s.name]));
    return head('Stock', `What is on the shelf: ${plural(products.length, 'product')}. What to reorder is on <a href="#forecast">Forecast</a>.`) +
      Object.entries(Object.groupBy(products, p => p.category)).map(([cat, ps]) => `<section class="sec"><h2>${esc(cap(cat))} <span class="n">${ps.length}</span></h2>
      ${table([['Product', p => `${esc(p.name)}<span class="sub">${esc(p._id)}</span>`, 'lead'], ['In stock', p => p.stock, 'num big'], ['Sells at', p => inr(p.price), 'num'], ['Costs you', p => inr(p.cost), 'num'], ['Supplier', p => esc(sup[p.supplierId] ?? p.supplierId)], ['Delivery takes', p => plural(p.leadTimeDays, 'day'), 'num']], ps)}</section>`).join('');
  },

  async forecast() {
    const f = await api('/forecast');
    const COVER_DAYS = 21, frac = n => Math.min(n / COVER_DAYS, 1);
    return head('Forecast', 'What sells in the next 7 days, and how long your stock lasts against how long a new delivery takes.') +
    `<section><p>${methodNote(f.method)} <span class="quiet">${esc(f.model ?? '')} · learned from ${f.historyDays} days of sales · worked out ${esc(when(f.createdAt))}</span></p>
      ${f.demandNote ? `<p class="warn">${esc(f.demandNote)}</p>` : ''}
      ${f.fallbackReason ? `<p class="warn">Why the fallback: ${esc(f.fallbackReason)}</p>` : ''}
      <div class="acts gap"><button class="btn" onclick="refreshForecast(this)">Work it out again</button></div></section>
    <section class="sec">${table([
      ['Product', r => esc(r.name), 'lead'],
      ['Left', r => `${r.available}<span class="sub">${r.stock} in stock, ${r.reserved} held</span>`, 'num big'],
      ['Sold last 7 days', r => r.last7Sold, 'num wide'],
      ['Next 7 days', r => r.demand7, 'num'],
      ['Lasts', r => `${r.daysOfCover == null ? 'Not running out' : plural(r.daysOfCover, 'day')} <span class="quiet">· delivery ${plural(r.leadTimeDays, 'day')}</span>
        <div class="cover ${LEVEL[r.risk]}" style="--cover:${r.daysOfCover == null ? 1 : frac(r.daysOfCover)};--lead:${frac(r.leadTimeDays)}" role="img" aria-label="${r.daysOfCover == null ? 'Not running out' : plural(r.daysOfCover, 'day')} of stock, delivery takes ${plural(r.leadTimeDays, 'day')}"></div>`],
      ['Risk', r => risk(r.risk)],
      ['Order', r => r.reorderQty || '—', 'num big']], f.items)}
    <p class="note">Bar: days of stock, up to 3 weeks. Notch: days a new delivery takes. Red means it runs out before a reorder could arrive; amber means it runs out within 7 days. Order covers the delivery time + 7 days + 3 safety days, minus what is left after pending orders; 0 when the product is fine.</p></section>`;
  },

  async suppliers() {
    const s = await api('/suppliers');
    return head('Suppliers', 'Who you buy from, what others quote, and the rules Nivara remembers for you.') +
    `<section class="sec"><h2>Check a price online</h2>
      <div class="field"><input id="sq" aria-label="Product to search" placeholder="Product, e.g. whey protein 1kg" value="Chocolate Protein Bar" onkeydown="if(event.key==='Enter')supSearch($('#sbtn'))"><button class="btn primary" id="sbtn" onclick="supSearch(this)">Search prices</button></div>
      <div id="sres" aria-live="polite"></div></section>
    <section class="sec"><h2>Cheaper quotes <span class="n">${s.opportunities.filter(o => o.significant).length}</span></h2>
      <p class="lede">Stored quotes against what you pay now. Faded rows save too little to count.</p>
      ${s.opportunities.length ? `<ul class="rows">${s.opportunities.map(o => row({ level: o.significant ? 'light' : '', dim: !o.significant, name: esc(o.name),
        why: `${esc(o.best.supplier)} at ${inr(o.best.unitCost)}. You pay ${inr(o.currentCost)} at ${esc(o.currentSupplier)}.${o.skippedBlocked.length ? `<br>Left out, blocked: ${esc(o.skippedBlocked.join(', '))}` : ''}`,
        fig: `<b>${inr(o.savingPerUnit)}</b><span>less a unit · ${o.savingPercent}%${o.significant ? '' : ' · not counted'}</span>` })).join('')}</ul>` : '<p class="empty">No cheaper quotes stored.</p>'}</section>
    <section class="sec"><h2>What Nivara remembers</h2><div id="mem"><p class="loading">Loading…</p></div>
      <label class="lbl gap" for="mtext">Tell it something to remember</label>
      <div class="field"><input id="mtext" placeholder="e.g. I never buy from Supplier C" onkeydown="if(event.key==='Enter')saveMem($('#mbtn'))"><button class="btn" id="mbtn" onclick="saveMem(this)">Remember</button></div></section>`;
  },

  async workflows() {
    const w = await api('/workflows');
    return head('Workflows', w.temporal ? `${st('light', 'Temporal connected')} <a href="${esc(w.uiUrl)}" target="_blank" rel="noopener">Open the Temporal UI</a>` : st('mid', 'Temporal unavailable: workflows run in-process')) +
    `<section>${w.schedule ? `<p>Next morning brief: <b>${esc(when(w.schedule.next))}</b></p>` : ''}</section>
    <section class="sec"><h2>Run now</h2><ul class="rows">${Object.entries(WF).map(([n, label]) => row({ level: null, name: label, why: `<span class="small">${n}</span>`, act: `<button class="btn" onclick="runWf('${n}', this)">Run</button>` })).join('')}</ul>
      <div id="wfout" aria-live="polite"></div></section>
    ${w.runs.length ? `<section class="sec"><h2>Recent runs</h2>${table([['Workflow', r => esc(WF[r.type] ?? r.type), 'lead'], ['ID', r => `<span class="small">${esc(r.id)}</span>`], ['Status', r => st(r.status === 'COMPLETED' ? 'light' : r.status === 'RUNNING' ? 'mid' : 'heavy', cap(r.status.toLowerCase()))], ['Started', r => esc(when(r.start)), 'num']], w.runs)}</section>` : ''}
    <section class="sec"><h2>Recent briefs</h2>${table([['When', r => esc(when(r.createdAt)), 'lead'], ['By', r => esc(r.by)], ['Brief', r => `<pre class="small">${esc(r.text)}</pre>`]], w.briefs)}</section>`;
  },

  async activity() {
    const { traces } = await api('/traces');
    return head('Activity', `Every answer, order reading and workflow step is traced: model calls, tool calls, time taken, errors. ${health?.integrations?.sentry?.status === 'live' ? 'Also sent to Sentry.' : 'Sentry is not set up, so traces stay here.'}`) +
    `<section>${table([['When', r => esc(when(r.at)), 'lead'], ['What', r => esc(r.kind)], ['Input', r => esc(String(r.input ?? '').slice(0, 80))], ['Took', r => `${r.ms} ms`, 'num'], ['Result', r => r.error ? st('heavy', String(r.error).slice(0, 80)) : st('light', 'OK')], ['', r => `<button class="link" onclick="showTrace('${esc(r._id)}')">Spans</button>`]], traces, 'No traces yet. Ask a question or read an order message and it shows up here.')}</section><div id="trace"></div>`;
  },

  async health() {
    health = await api('/health');
    return head('Health', 'What is connected. When something is down, Nivara falls back and keeps working with less.') +
      `<section><ul class="rows">${Object.entries(health.integrations).map(([k, v]) => row({ level: v.status === 'live' ? 'light' : 'mid', name: esc(HEALTH[k] ?? k), why: esc(v.detail),
        fig: `<b class="${v.status === 'live' ? 'green' : 'amber'}">${v.status === 'live' ? 'Live' : 'Fallback'}</b>` })).join('')}</ul></section>`;
  },
};
const WF = { dailyBriefWorkflow: 'Morning brief', lowStockWorkflow: 'Low-stock check', forecastWorkflow: 'Forecast', supplierRefreshWorkflow: 'Online prices' };
const HEALTH = { mongodb: 'MongoDB Atlas', gemma: 'Gemma', mastra: 'Mastra tools', tabpfn: 'TabPFN forecast', tiger: 'Tiger Data', serpapi: 'SerpApi prices', backboard: 'Backboard memory', elevenlabs: 'ElevenLabs voice', temporal: 'Temporal', sentry: 'Sentry' };
const TITLES = { dashboard: 'Today', assistant: 'Ask', orders: 'Orders', inventory: 'Stock', forecast: 'Forecast', suppliers: 'Suppliers', workflows: 'Workflows', activity: 'Activity', health: 'Health' };

function go(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  el.focus({ preventScroll: true });
  el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 1600);
}

// ---------- assistant ----------
const turns = [];
const tries = list => list.length ? `<ul class="tries">${list.map(q => `<li><button class="link" onclick="send(this.textContent)">${esc(q)}</button></li>`).join('')}</ul>` : '';
const askBox = (list, titled = true) => `<section class="sec ask" id="ask" tabindex="-1"${titled ? ' aria-labelledby="ask-h"' : ' aria-label="Ask"'}>${titled ? '<h2 id="ask-h">Ask</h2>' : ''}
  <div class="field"><input id="q" placeholder="Which orders are late?" aria-label="Ask about your shop" onkeydown="if(event.key==='Enter')send(this.value)"><button class="btn primary" onclick="send($('#q').value)">Ask</button><button class="btn" id="mic" onclick="listen(this)">Speak</button></div>
  ${tries(list)}
  <p class="small quiet voice" id="voicemode"></p>
  <div class="log" id="chat" aria-live="polite">${drawTurns()}</div></section>`;
const MODE = { template: 'written from database facts', 'template+gemma': 'database facts, summary by Gemma' };
function renderTurn(t) {
  const r = t.r;
  if (!r) return `<article class="turn"><p class="q">${esc(t.q)}</p><p class="quiet">Working it out. Gemma runs on your own machine, so this can take a few seconds.</p></article>`;
  const mode = r.answerMode === 'gemma' ? `written by ${r.model}` : MODE[r.answerMode] ?? r.answerMode;
  return `<article class="turn"><p class="q">${esc(t.q)}</p><pre class="a">${esc(r.answer)}</pre>
    <p class="meta">${[mode && `<span>${esc(cap(mode))}</span>`, r.traceId && `<a href="#activity">Trace ${esc(r.traceId.slice(0, 8))}</a>`, `<button class="link" onclick="speak(${turns.indexOf(t)})">Read aloud</button>`].filter(Boolean).join('')}</p>
    <details><summary>How this was answered</summary><p>Tool ${esc(r.tool)} · route ${esc(r.route)}</p>${r.notes?.length ? `<p>${r.notes.map(esc).join('<br>')}</p>` : ''}
      ${r.data ? `<pre>${esc(JSON.stringify(r.data, null, 1).slice(0, 4000))}</pre>` : ''}</details></article>`;
}
function drawTurns() { return turns.slice().reverse().map(renderTurn).join(''); }
const drawLog = () => { if ($('#chat')) $('#chat').innerHTML = drawTurns(); };
async function send(text) {
  text = (text || '').trim();
  if (!text) return;
  const history = turns.flatMap(t => [{ role: 'user', content: t.q }, ...(t.r ? [{ role: 'assistant', content: t.r.answer.slice(0, 4000) }] : [])]).slice(-8);
  const t = { q: text };
  turns.push(t);
  if ($('#q')) $('#q').value = '';
  drawLog();
  try { t.r = await api('/assistant', { method: 'POST', body: { message: text, history } }); }
  catch (e) { t.r = { answer: `Couldn't answer that: ${e.message}`, route: 'error', tool: '-' }; }
  drawLog();
}
const elevenOn = () => health?.integrations?.elevenlabs?.status === 'live';
const voiceNotice = msg => { if ($('#voicemode')) $('#voicemode').textContent = msg; };
async function speak(i) {
  const text = turns[i].r.answer;
  if (elevenOn()) {
    const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).catch(e => ({ ok: false, statusText: e.message }));
    if (r.ok) return new Audio(URL.createObjectURL(await r.blob())).play();
    voiceNotice(`ElevenLabs speech failed (${r.status || r.statusText}). Using browser speech.`);
  }
  speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(text), { lang: 'en-IN' }));
}
let rec;
async function listen(btn) {
  const label = btn.dataset.label ??= btn.textContent;
  if (elevenOn() && window.MediaRecorder && navigator.mediaDevices) {
    if (rec?.state === 'recording') return rec.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      rec = new MediaRecorder(stream);
      rec.ondataavailable = e => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop()); btn.textContent = label;
        const blob = new Blob(chunks, { type: rec.mimeType }); // Safari records audio/mp4, Chrome audio/webm
        const r = await fetch('/api/voice/stt', { method: 'POST', headers: { 'content-type': blob.type.split(';')[0] || 'audio/webm' }, body: blob }).catch(e => ({ ok: false, json: async () => ({ error: e.message }) }));
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.text) return send(j.text);
        voiceNotice(`ElevenLabs transcription failed (${j.error || r.status}). Speak again: using browser speech.`);
        browserListen(btn, label);
      };
      rec.start(); btn.textContent = 'Stop';
      return;
    } catch (e) { voiceNotice(`Microphone recording unavailable (${e.message}). Using browser speech.`); }
  }
  browserListen(btn, label);
}
function browserListen(btn, label) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return voiceNotice('Voice needs an ElevenLabs key, or a browser with speech recognition (Chrome, Edge, Safari).');
  const sr = new SR(); sr.lang = 'en-IN';
  sr.onresult = e => send(e.results[0][0].transcript);
  sr.onend = () => (btn.textContent = label);
  btn.textContent = 'Listening…'; sr.start();
}

// ---------- orders ----------
let draft;
async function extract(btn) {
  $('#draft').innerHTML = '<p class="loading" role="status">Gemma is reading the message…</p>';
  try {
    const r = await busy(btn, 'Reading…', () => api('/orders/extract', { method: 'POST', body: { text: $('#otext').value }, retry: true }));
    draft = r.draft;
    const unmatched = draft.items.some(i => !i.product);
    $('#draft').innerHTML = `<div class="sec"><h2>Check this order</h2>
      <p class="lede"><b>${esc(draft.customer.name)}</b> ${draft.customer.isNew ? st('mid', 'New customer') : `<span class="small">${esc(draft.customer.id)}</span>`}
        · Delivery <b>${draft.deliveryDate ? esc(day(draft.deliveryDate)) : 'not given'}</b>${draft.deliveryText ? ` <span class="small">from “${esc(draft.deliveryText)}”</span>` : ''}</p>
      ${table([['Asked for', i => esc(i.requested), 'lead'], ['Matched product', i => i.product ? `${esc(i.product.name)}<span class="sub">${esc(i.product.sku)}</span>` : st('heavy', 'No match')], ['Qty', i => i.quantity, 'num big'], ['Price', i => i.product ? inr(i.product.price) : '—', 'num'], ['In stock', i => i.product?.stock ?? '—', 'num']], draft.items)}
      <p class="total">Total <b>${inr(draft.total)}</b></p>
      ${draft.problems.length ? `<p class="warn">${draft.problems.map(esc).join('<br>')}</p>` : ''}
      <div class="acts gap"><button class="btn primary" onclick="confirmOrder(this)" ${unmatched ? 'disabled title="Fix the unmatched items first"' : ''}>Confirm and save</button>${unmatched ? '<span class="small red">Fix the unmatched items in the message first.</span>' : ''}</div>
      <details class="note"><summary>What Gemma read (validated)</summary><pre>${esc(JSON.stringify(r.extraction, null, 1))}</pre></details></div>`;
  } catch (e) { $('#draft').innerHTML = errorBox(e, 'read the message', () => extract(btn)); }
}
async function confirmOrder(btn) {
  try {
    const o = await busy(btn, 'Saving…', () => api('/orders', { method: 'POST', body: { customerId: draft.customer.id, customerName: draft.customer.name, items: draft.items.map(i => ({ sku: i.product.sku, quantity: i.quantity })), deliveryDate: draft.deliveryDate } }));
    flash = `Saved ${orderName(o._id)} for ${draft.customer.name}.`; route();
  } catch (e) { showError(btn, errorBox(e, 'save the order', () => confirmOrder(btn))); }
}
async function deliver(id, btn) {
  try { await busy(btn, 'Saving…', () => api(`/orders/${id}/deliver`, { method: 'POST' })); flash = `${orderName(id)} marked delivered.`; route(); }
  catch (e) { showError(btn, errorBox(e, `mark ${orderName(id)} delivered`, () => deliver(id, btn))); }
}
async function refreshForecast(btn) {
  try { await busy(btn, 'Working it out…', () => api('/forecast?force=1', { timeoutMs: API.longTimeoutMs })); route(); }
  catch (e) { showError(btn, errorBox(e, 'work out the forecast', () => refreshForecast(btn))); }
}

// ---------- suppliers / memory ----------
async function supSearch(btn) {
  $('#sres').innerHTML = '<p class="loading" role="status">Searching…</p>';
  try {
    const r = await busy(btn, 'Searching…', () => api('/suppliers/search?q=' + encodeURIComponent($('#sq').value)));
    $('#sres').innerHTML = `<p class="lede gap">${r.product ? `Matched <b>${esc(r.product.name)}</b>. You pay ${inr(r.product.cost)} and sell at ${inr(r.product.price)}.` : 'Not in your catalogue, so it was searched as typed.'}</p>
      ${r.web.available ? `${r.web.hiddenBlocked ? `<p class="note">${plural(r.web.hiddenBlocked, 'result')} hidden: blocked supplier.</p>` : ''}${table([['Listing', o => `<a href="${esc(o.link)}" target="_blank" rel="noopener">${esc(o.title)}</a>`], ['Seller', o => `${esc(o.source)}<span class="sub">${esc(o.sourceDomain)}</span>`], ['Price', o => inr(o.price), 'num big']], r.web.offers.slice().sort((a, b) => a.price - b.price))}<p class="note">Live Google Shopping results via SerpApi. Retail listings: check the pack size before comparing with your unit cost.</p>` : `<p class="warn">${esc(r.web.reason)}</p>`}
      ${r.dbOpportunity ? `<p class="lede gap">Stored quote: <b>${esc(r.dbOpportunity.best.supplier)}</b> at ${inr(r.dbOpportunity.best.unitCost)} a unit, ${inr(r.dbOpportunity.savingPerUnit)} less (${r.dbOpportunity.savingPercent}%${r.dbOpportunity.significant ? '' : ', too small to count'}).</p>` : ''}
      ${r.memory ? `<p class="note">Blocked-supplier memory: ${esc(r.memory.source)}</p>` : ''}`;
  } catch (e) { $('#sres').innerHTML = errorBox(e, 'search prices', () => supSearch(btn)); }
}
async function loadMem() {
  let m;
  try { m = await api('/memory'); }
  catch (e) { if ($('#mem')) $('#mem').innerHTML = errorBox(e, 'load what Nivara remembers', loadMem); return; }
  if ($('#mem')) $('#mem').innerHTML = (m.preferences.length ? `<ul class="rows">${m.preferences.map(p => row({ level: null, name: `“${esc(p.text)}”`,
    why: `${p.kind === 'block_supplier' ? `Blocks ${esc(p.supplier)}` : cap(esc(p.kind))} · stored in ${p.mirror === 'backboard' ? 'Mongo and Backboard' : 'Mongo only'}` })).join('')}</ul>` : '<p class="empty">Nothing remembered yet.</p>') +
    `<p class="note">Backboard: ${m.backboard.live ? `live, ${plural(m.backboard.memories.length, 'memory', 'memories')}` : esc(m.backboard.error || 'not set up (no BACKBOARD_API_KEY)')}</p>`;
}
async function saveMem(btn) {
  try { await busy(btn, 'Saving…', () => api('/memory', { method: 'POST', body: { text: $('#mtext').value } })); flash = 'Remembered.'; route(); }
  catch (e) { showError(btn, errorBox(e, 'save that', () => saveMem(btn))); }
}

// ---------- workflows / traces ----------
async function runWf(name, btn) {
  const out = $('#wfout');
  out.innerHTML = `<p class="note" role="status">Running ${esc(WF[name] ?? name)}…</p>`;
  try {
    const r = await busy(btn, 'Running…', () => api(`/workflows/${name}/run`, { method: 'POST', timeoutMs: API.longTimeoutMs }));
    out.innerHTML = `<details class="note"><summary>Details</summary><pre>${esc(JSON.stringify(r, null, 1))}</pre></details>`;
    if (location.hash === '#dashboard' || !location.hash) { flash = `${WF[name]} done.`; route(); }
  } catch (e) { out.innerHTML = errorBox(e, `run ${(WF[name] ?? name).toLowerCase()}`, () => runWf(name, btn)); }
}
async function showTrace(id) {
  try {
    const t = await api('/traces/' + encodeURIComponent(id));
    const t0 = t.spans[0]?.start ?? 0;
    $('#trace').innerHTML = `<section class="sec"><h2>${esc(t.kind)} <span class="n">${t.ms} ms · ${esc(id.slice(0, 8))}</span></h2>
      ${table([['+ms', s => s.start - t0, 'num'], ['Span', s => `<b>${esc(s.op)}</b> ${esc(s.name)}`], ['Took', s => `${s.ms} ms`, 'num'], ['Attributes', s => `<details><summary class="small">${plural(Object.keys(s.attrs).length, 'attribute')}</summary><pre class="small">${esc(JSON.stringify(s.attrs, null, 1))}</pre></details>`], ['Error', s => s.error ? st('heavy', s.error) : '']], t.spans)}
      <p class="lede gap"><b>Final output:</b> ${esc(t.output)}</p></section>`;
    go('trace');
  } catch (e) { $('#trace').innerHTML = errorBox(e, 'load the trace', () => showTrace(id)); }
}

// ---------- router ----------
let first = true;
async function route() {
  const name = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
  document.querySelectorAll('.nav a, #more a').forEach(a => a.hash === '#' + name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  $(`#more a[href="#${name}"]`) ? $('.more').setAttribute('aria-current', 'page') : $('.more').removeAttribute('aria-current');
  try { $('#more').hidePopover(); } catch {}
  document.title = `${TITLES[name]} · Nivara`;
  const note = flash; flash = '';
  retries.clear();
  $('#view').innerHTML = '<p class="loading" role="status">Loading…</p>';
  try {
    $('#view').innerHTML = (note ? `<p class="flash" role="status">${st('light', 'Done')} ${esc(note)}</p>` : '') + await views[name]();
    if (name === 'suppliers') loadMem();
    voiceNotice(elevenOn() ? 'Voice: ElevenLabs' : `Voice: browser speech (${health?.integrations?.elevenlabs?.detail ?? 'ElevenLabs not live'})`);
  } catch (e) { $('#view').innerHTML = `<div class="sec">${errorBox(e, `load ${TITLES[name]}`, route)}</div>`; }
  if (!first) { scrollTo(0, 0); const h = $('#view h1'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
  first = false;
}
addEventListener('hashchange', route);
api('/health').then(h => (health = h)).catch(() => {}).finally(route);
