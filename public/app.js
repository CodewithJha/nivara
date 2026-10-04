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
      ${f.fallbackReason ? `<p class="warn">Why the fallback: ${esc(f.fallbackReason)}</p>` : ''}
      <div class="acts gap"><button class="btn" onclick="this.disabled=true;api('/forecast?force=1').then(route, e => this.insertAdjacentHTML('afterend', fail(e)))">Work it out again</button></div></section>
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
      <pre class="out" id="wfout" role="status"></pre></section>
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
const HEALTH = { mongodb: 'MongoDB', gemma: 'Gemma', mastra: 'Mastra tools', tabpfn: 'TabPFN forecast', serpapi: 'SerpApi prices', backboard: 'Backboard memory', elevenlabs: 'ElevenLabs voice', temporal: 'Temporal', sentry: 'Sentry' };
const TITLES = { dashboard: 'Today', assistant: 'Ask', orders: 'Orders', inventory: 'Stock', forecast: 'Forecast', suppliers: 'Suppliers', workflows: 'Workflows', activity: 'Activity', health: 'Health' };

function go(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  el.focus({ preventScroll: true });
  el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 1600);
}
