// Plain JS, no build. Every number rendered here comes from an API response backed by Mongo.
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const whole = n => Math.round(Number(n) || 0);
const plural = (n, one, many = one + 's') => `${whole(n)} ${whole(n) === 1 ? one : many}`;
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
/** Answer text → short paragraphs plus a list for "• " lines. */
function answerHtml(text) {
  let html = '', list = [];
  const flush = () => { if (list.length) html += `<ul class="pts">${list.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`; list = []; };
  for (const l of String(text ?? '').split('\n').map(x => x.trim()).filter(Boolean)) {
    if (/^[•*-]\s/.test(l)) list.push(l.replace(/^[•*-]\s+/, ''));
    else { flush(); html += `<p>${esc(l)}</p>`; }
  }
  flush();
  return html;
}

const tr = cols => r => `<tr>${cols.map(c => `<td class="${c[2] ?? ''}" data-label="${esc(c[0])}"><div>${c[1](r)}</div></td>`).join('')}</tr>`;
const tableOf = (cols, body, lazy) => `<table><thead><tr>${cols.map(c => `<th scope="col" class="${c[2] ?? ''}">${c[0]}</th>`).join('')}</tr></thead><tbody${lazy == null ? '' : ` data-lazy="${lazy}"`}>${body}</tbody></table>`;
const table = (cols, rows, empty = 'Nothing here yet.') => rows.length ? tableOf(cols, rows.map(tr(cols)).join('')) : `<p class="empty">${empty}</p>`;
/** Sections of long tables ({ before, cols, rows, after }): the first rows draw now, the rest as the reader scrolls (lazy.js). */
const lazyTables = secs => progressive(secs.map(s => ({ rows: s.rows, row: tr(s.cols), html: (body, g) => s.before + tableOf(s.cols, body, g) + (s.after ?? '') })));

// ---------- errors and pending buttons ----------
// One error component for every failed request: plain words (api.js OOPS / the server's friendly message) and a Retry.
// Nothing technical is shown: no status codes, no raw messages.
const retries = new Map();
let retrySeq = 0;
const friendly = e => !navigator.onLine ? OOPS.offline : e instanceof ApiError ? e.friendly : OOPS.server;
function errorBox(e, what, retry) {
  const id = ++retrySeq;
  if (retry) retries.set(id, retry);
  return `<div class="err" role="alert" data-err="${id}"><p>Couldn't ${esc(what)}. ${esc(friendly(e))}</p>
    ${retry ? `<div class="acts"><button class="btn" onclick="retryNow(${id})">Retry</button></div>` : ''}</div>`;
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
  const left = r.available <= 0 ? 'None left after pending orders' : `${r.available} left of ${r.stock}`;
  const lasts = r.daysOfCover == null || r.available <= 0 ? '' : `, about ${plural(Math.max(1, r.daysOfCover), 'day')} of stock`;
  return `${left}${lasts}. ${r.risk === 'high' ? `New stock takes ${plural(r.leadTimeDays, 'day')}.` : 'Runs out this week.'}`;
}
let health = null, flash = '';

const views = {
  async dashboard() {
    const d = await api('/dashboard');
    const p = d.pending.orders, hp = d.highPriority, th = d.supplierThreshold, f = d.forecast;
    const listed = (xs, n = 3) => xs.length > n ? `${xs.slice(0, n).join(', ')} and ${plural(xs.length - n, 'more')}` : xs.join(', ');
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
        facts: `${o.best.supplier} sells it at ${inr(o.best.unitCost)}. You pay ${inr(o.currentCost)} at ${o.currentSupplier}. That's ${inr(o.savingPerUnit)} less a unit, ${o.savingPercent}% cheaper.`,
        acts: '<a class="btn primary" href="#suppliers">Compare suppliers</a>' })),
    ];
    const top = jobs[0], tapPlates = matchMedia('(min-width: 900px)').matches; // phone plates are too thin to tap; the rows carry the jump
    const plates = loadPlates(jobs, matchMedia('(min-width: 600px)').matches ? MAX_PLATES.wide : MAX_PLATES.narrow), more = jobs.length - plates.length;
    const count = Object.entries(Object.groupBy(jobs, j => j.level));
    return `<section class="load bleed" aria-label="Today's load">
      <div class="words"><p class="date">${esc(new Date(d.date + 'T00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }))}</p>
      <p class="tally">${count.length ? count.map(([lvl, js]) => `<span>${js.length} <span class="k">${WEIGHT[lvl]}</span></span>`).join('') : 'Empty bar. Nothing to lift today.'}</p></div>
      <div class="barbell"><span class="shaft" aria-hidden="true"></span><span class="collar" aria-hidden="true"></span>
        <div class="plates">${plates.map(({ level, job, count }, i) => {
          const label = `${job.title}${count > 1 ? ` and ${plural(count - 1, 'more job')}` : ''}`;
          return tapPlates
            ? `<button class="plate ${level}" style="--i:${i}" aria-label="${esc(label)}, ${WEIGHT[level]}" title="${esc(label)}" onclick="go('${esc(job.to)}')"></button>`
            : `<span class="plate ${level}" style="--i:${i}" aria-hidden="true"></span>`;
        }).join('')}</div>
        <span class="clip" aria-hidden="true"></span><span class="sleeve" aria-hidden="true"></span><span class="cap" aria-hidden="true"></span>
        ${more > 0 ? `<span class="extra" title="${plural(jobs.length, 'job')} on ${plates.length} plates">+${more}</span>` : ''}</div>
      ${d.demo ? '<p class="demo">Sample shop data. Your own products and orders will replace it.</p>' : ''}
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
          why: `${esc(restockWhy(r))} About ${plural(r.demand7, 'sale')} expected in the next 7 days.`, fig: r.reorderQty ? `<b>${r.reorderQty}</b><span>to order</span>` : '' })).join('')}</ul>` : '<p class="empty">Nothing runs out this week.</p>'}
        ${f.date && f.date !== d.date ? `<p class="note">This list is from ${esc(day(f.date))}. <a href="#forecast">Work it out again</a> for today.</p>` : ''}</section>
      <section class="sec" id="save"><h2>Pay less <span class="n">${worth.length}</span></h2>
        <p class="lede">From the quotes you stored. A quote counts when it saves at least ${inr(th.rupees)} and ${th.percent}% a unit.</p>
        ${worth.length ? `<ul class="rows">${worth.map(o => row({ id: 's-' + o.sku, level: 'light', name: esc(o.name),
          why: `${esc(o.best.supplier)} at ${inr(o.best.unitCost)}. You pay ${inr(o.currentCost)} at ${esc(o.currentSupplier)}.`,
          fig: `<b>${inr(o.savingPerUnit)}</b><span>less a unit · ${o.savingPercent}%</span>` })).join('')}</ul>` : '<p class="empty">Your suppliers are already the cheapest you have quotes for.</p>'}
        ${small.length ? `<p class="note">Too small to switch for: ${esc(listed(small.map(o => o.name)))}.</p>` : ''}
        ${d.opportunities.some(o => o.skippedBlocked.length) ? `<p class="note">Left out because you blocked them: ${esc([...new Set(d.opportunities.flatMap(o => o.skippedBlocked))].join(', '))}.</p>` : ''}
        ${d.livePrices.length ? `<h3 class="h2 sec">Online prices</h3>${table([['Product', r => esc(r.name), 'lead'], ['Cheapest online', r => r.cheapest ? `${inr(r.cheapest.price)}${r.link ? ` · <a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.cheapest.source)}</a>` : ` · ${esc(r.cheapest.source)}`}` : '<span class="quiet">No prices found</span>', 'num']], d.livePrices)}
          <p class="note">Updated each morning. These are shop prices, so check the pack size before comparing with your cost.</p>`
        : `<p class="note">${d.onlinePrices ? 'No online prices yet. Make a fresh brief to check them.' : 'Online prices are not set up. Showing your stored quotes.'}</p>`}</section>
    </div>
    <aside>
      ${askBox(['What should I restock?', 'Show my pending orders.', 'What sold the most?', 'What should I focus on today?'])}
      <section class="sec brief"><h2>${d.brief?.date === d.date ? 'Morning brief' : 'Latest brief'}</h2>
        ${d.brief ? `<p class="note">${esc(when(d.brief.createdAt))}</p><div class="a sec-gap">${answerHtml(d.brief.text)}</div>` : '<p class="empty">No brief yet. One is made every morning at 8, or make one now.</p>'}
        <div class="acts"><button class="btn" onclick="runWf('dailyBriefWorkflow', this)">Make a fresh brief</button></div><div id="wfout" aria-live="polite"></div></section>
    </aside></div>`;
  },

  async assistant() {
    setTimeout(() => $('#q')?.focus());
    return head('Ask', 'Ask about stock, orders, suppliers or your day. Answers come from your own shop data.') +
      `<div class="day"><div>${askBox([], false)}</div>
      <aside><section class="sec"><h2>Try asking</h2>${tries(["Give me today's business brief", 'What should I restock?', 'Which products are likely to run out?', 'Why are you recommending this?', 'What did I sell the most this week?', 'Find cheaper suppliers for this product', 'What orders are still pending?', "Remember that I don't buy from Supplier C"])}</section></aside></div>`;
  },

  async orders() {
    const [{ orders }, d] = await Promise.all([api('/orders'), api('/dashboard')]);
    const pending = d.pending.orders, done = orders.filter(o => o.status !== 'pending');
    return head('Orders', `${plural(pending.length, 'order')} to deliver.${orders.some(o => o.demo) ? ' Includes sample orders.' : ''}`) +
    `<section class="sec"><h2>New order from a chat</h2>
      <p class="lede">Paste the WhatsApp or Instagram message. Nivara reads it and checks each product and customer against your records. Nothing is saved until you confirm.</p>
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
      lazyTables(Object.entries(Object.groupBy(products, p => p.category)).map(([cat, ps]) => ({ before: `<section class="sec"><h2>${esc(cap(cat))} <span class="n">${ps.length}</span></h2>`, after: '</section>', rows: ps,
        cols: [['Product', p => esc(p.name), 'lead'], ['In stock', p => p.stock, 'num big'], ['Sells at', p => inr(p.price), 'num'], ['Costs you', p => inr(p.cost), 'num'], ['Supplier', p => esc(sup[p.supplierId] ?? p.supplierId)], ['Delivery takes', p => plural(p.leadTimeDays, 'day'), 'num']] })));
  },

  async forecast() {
    const f = await api('/forecast');
    const COVER_DAYS = 21, frac = n => Math.min(n / COVER_DAYS, 1);
    const cols = [
      ['Product', r => esc(r.name), 'lead'],
      ['Left', r => `${r.available}<span class="sub">${r.stock} in stock, ${r.reserved} held</span>`, 'num big'],
      ['Sold last 7 days', r => whole(r.last7Sold), 'num wide'],
      ['Next 7 days', r => whole(r.demand7), 'num'],
      ['Lasts', r => `${r.daysOfCover == null ? 'Not running out' : plural(Math.max(r.available > 0 ? 1 : 0, r.daysOfCover), 'day')} <span class="quiet">· delivery ${plural(r.leadTimeDays, 'day')}</span>
        <div class="cover ${LEVEL[r.risk]}" style="--cover:${r.daysOfCover == null ? 1 : frac(r.daysOfCover)};--lead:${frac(r.leadTimeDays)}" role="img" aria-label="${r.daysOfCover == null ? 'Not running out' : plural(r.daysOfCover, 'day')} of stock, delivery takes ${plural(r.leadTimeDays, 'day')}"></div>`],
      ['Risk', r => risk(r.risk)],
      ['Order', r => r.reorderQty || '—', 'num big']];
    const note = '<p class="note">The bar shows days of stock, up to 3 weeks; the notch shows how long a delivery takes. Red runs out before a reorder could arrive. Amber runs out within 7 days. Order covers the delivery time, a week of sales and 3 spare days.</p>';
    return head('Forecast', 'What sells in the next 7 days, and how long your stock lasts against how long a new delivery takes.') +
    `<section><p class="quiet">Based on your last ${plural(f.historyDays ?? 60, 'day')} of sales.</p>
      <div class="acts gap"><button class="btn" onclick="refreshForecast(this)">Work it out again</button></div></section>` +
      (f.items.length ? lazyTables([{ before: '<section class="sec">', cols, rows: f.items, after: note + '</section>' }]) : `<section class="sec">${table(cols, [], 'No products yet.')}${note}</section>`);
  },

  async suppliers() {
    const s = await api('/suppliers');
    return head('Suppliers', 'Who you buy from, what others quote, and the rules Nivara remembers for you.') +
    `<section class="sec"><h2>Check a price online</h2>
      <div class="field"><input id="sq" aria-label="Product to search" placeholder="Product, e.g. whey protein 1kg" value="Chocolate Protein Bar" onkeydown="if(event.key==='Enter')supSearch($('#sbtn'))"><button class="btn primary" id="sbtn" onclick="supSearch(this)">Search prices</button></div>
      <div id="sres" aria-live="polite"></div></section>
    <section class="sec"><h2>Cheaper quotes <span class="n">${s.opportunities.filter(o => o.significant).length}</span></h2>
      <p class="lede">Stored quotes against what you pay now. Faded rows save too little to switch for.</p>
      ${s.opportunities.length ? `<ul class="rows">${s.opportunities.map(o => row({ level: o.significant ? 'light' : '', dim: !o.significant, name: esc(o.name),
        why: `${esc(o.best.supplier)} at ${inr(o.best.unitCost)}. You pay ${inr(o.currentCost)} at ${esc(o.currentSupplier)}.${o.skippedBlocked.length ? `<br>Left out, blocked: ${esc(o.skippedBlocked.join(', '))}` : ''}`,
        fig: `<b>${inr(o.savingPerUnit)}</b><span>less a unit · ${o.savingPercent}%</span>` })).join('')}</ul>` : '<p class="empty">No cheaper quotes stored.</p>'}</section>
    <section class="sec"><h2>What Nivara remembers</h2><div id="mem"><p class="loading">Loading…</p></div>
      <label class="lbl gap" for="mtext">Tell it something to remember</label>
      <div class="field"><input id="mtext" placeholder="e.g. I never buy from Supplier C" onkeydown="if(event.key==='Enter')saveMem($('#mbtn'))"><button class="btn" id="mbtn" onclick="saveMem(this)">Remember</button></div></section>`;
  },

  async workflows() {
    const w = await api('/workflows');
    return head('Workflows', `Jobs Nivara runs for you. ${w.schedule ? `Next morning brief: <b>${esc(when(w.schedule.next))}</b>.` : 'The morning brief runs every day at 8.'}`) +
    `<section class="sec"><h2>Run now</h2><ul class="rows">${Object.entries(WF).map(([n, label]) => row({ level: null, name: label, why: esc(WF_WHY[n]), act: `<button class="btn" onclick="runWf('${n}', this)">Run</button>` })).join('')}</ul>
      <div id="wfout" aria-live="polite"></div></section>
    ${w.runs.length ? `<section class="sec"><h2>Recent runs</h2>${table([['Job', r => esc(r.label), 'lead'], ['Status', r => st(r.status === 'done' ? 'light' : r.status === 'running' ? 'mid' : 'heavy', RUN_WORD[r.status] ?? 'Running')], ['Started', r => esc(when(r.start)), 'num']], w.runs)}</section>` : ''}
    <section class="sec"><h2>Recent briefs</h2>${w.briefs.length ? w.briefs.map(b => `<article class="run"><p class="note">${esc(when(b.createdAt))}</p><div class="a">${answerHtml(b.text)}</div></article>`).join('') : '<p class="empty">No briefs yet. Run the morning brief above.</p>'}</section>`;
  },

  async activity() {
    const { activity } = await api('/traces');
    return head('Activity', 'Behind the scenes: what Nivara did recently, the steps it took and how long they took.') +
    `<section>${activity.length ? `<ul class="rows">${activity.map(a => row({ level: a.ok ? 'light' : 'mid', name: esc(a.what),
      why: `${a.question ? `“${esc(a.question)}”<br>` : ''}${esc(when(a.at))}${a.steps.length ? `<details class="small"><summary>${plural(a.steps.length, 'step')}</summary><ul class="pts">${a.steps.map(s => `<li>${esc(s.label)} · ${secs(s.ms)}${s.ok ? '' : ' · did not finish'}</li>`).join('')}</ul></details>` : ''}`,
      fig: `<b>${secs(a.ms)}</b><span>${a.ok ? 'done' : 'did not finish'}</span>` })).join('')}</ul>` : '<p class="empty">Nothing yet. Ask a question or read an order message and it shows up here.</p>'}</section>`;
  },

  async health() {
    health = await api('/health');
    return head('Health', 'Behind the scenes: the services that power Nivara. When one rests, Nivara keeps working with less.') +
      `<section><ul class="rows">${Object.values(health.integrations).map(v => row({ level: v.status === 'live' ? 'light' : 'mid', name: esc(v.name), why: esc(v.note),
        fig: `<b class="${v.status === 'live' ? 'green' : 'amber'}">${v.status === 'live' ? 'Live' : 'Standby'}</b>` })).join('')}</ul></section>`;
  },
};
const secs = ms => ms < 1000 ? 'under 1 s' : `${Math.round(ms / 100) / 10} s`;
const RUN_WORD = { done: 'Done', running: 'Running', failed: 'Did not finish', stopped: 'Stopped' };
const WF_WHY = { dailyBriefWorkflow: 'Forecast, stock check, online prices and a fresh brief.', lowStockWorkflow: 'Lists what runs out soon.', forecastWorkflow: 'Works out next week’s sales again.', supplierRefreshWorkflow: 'Checks shop prices online.' };
const WF = { dailyBriefWorkflow: 'Morning brief', lowStockWorkflow: 'Low-stock check', forecastWorkflow: 'Forecast', supplierRefreshWorkflow: 'Online prices' };
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
  <div class="field"><input id="q" placeholder="Which orders are late?" aria-label="Ask about your shop" onkeydown="if(event.key==='Enter')send(this.value)"><button class="btn primary" id="askbtn" onclick="send($('#q').value)"${asking ? ' disabled aria-busy="true"' : ''}>${asking ? 'Thinking…' : 'Ask'}</button><button class="btn" id="mic" onclick="listen(this)">Speak</button></div>
  ${tries(list)}
  <p class="small quiet voice" id="voicemode"></p>
  <div class="log" id="chat" aria-live="polite">${drawTurns()}</div></section>`;
const canSpeak = () => elevenOn() || 'speechSynthesis' in window;
function renderTurn(t) {
  const r = t.r;
  if (t.error) return `<article class="turn"><p class="q">${esc(t.q)}</p>${errorBox(t.error, 'answer that', () => answer(t))}</article>`;
  if (!r) return `<article class="turn" aria-busy="true"><p class="q">${esc(t.q)}</p><p class="thinking" role="status"><span class="st">Thinking</span> Checking your orders, stock and suppliers.</p></article>`;
  return `<article class="turn"><p class="q">${esc(t.q)}</p><div class="a">${answerHtml(r.answer)}</div>
    ${canSpeak() ? `<p class="meta"><button class="link" onclick="speak(${turns.indexOf(t)})">Read aloud</button></p>` : ''}</article>`;
}
function drawTurns() { return turns.slice().reverse().map(renderTurn).join(''); }
const drawLog = () => { if ($('#chat')) $('#chat').innerHTML = drawTurns(); };
let asking = false;
function setAsking(on) {
  asking = on;
  const b = $('#askbtn');
  if (!b) return;
  b.disabled = on; b.toggleAttribute('aria-busy', on); b.textContent = on ? 'Thinking…' : 'Ask';
}
async function send(text) {
  text = (text || '').trim();
  if (!text || asking) return;
  const t = { q: text, history: turns.flatMap(t => [{ role: 'user', content: t.q }, ...(t.r ? [{ role: 'assistant', content: t.r.answer.slice(0, 4000) }] : [])]).slice(-8) };
  turns.push(t);
  if ($('#q')) $('#q').value = '';
  await answer(t);
}
async function answer(t) {
  t.error = undefined;
  setAsking(true); drawLog();
  try { t.r = await api('/assistant', { method: 'POST', body: { message: t.q, history: t.history }, retry: true }); }
  catch (e) { t.error = e; }
  setAsking(false); drawLog();
}
const elevenOn = () => health?.integrations?.elevenlabs?.status === 'live';
const voiceNotice = msg => { if ($('#voicemode')) $('#voicemode').textContent = msg; };
const VOICE = {
  off: "Voice isn't available in this browser. Type your question instead.",
  denied: 'The microphone is off for this site. Type your question instead.',
  missed: "Didn't catch that. Tap Speak to try again, or type it.",
};
const browserSpeak = text => { try { speechSynthesis.cancel(); speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(text), { lang: 'en-IN' })); } catch {} };
/** ElevenLabs when it is live; any failure (request, autoplay) quietly uses the browser voice instead. */
async function speak(i) {
  const text = turns[i]?.r?.answer;
  if (!text) return;
  if (!elevenOn()) return browserSpeak(text);
  try { await new Audio(URL.createObjectURL(await api('/voice/tts', { method: 'POST', body: { text }, as: 'blob', retry: true }))).play(); }
  catch { browserSpeak(text); }
}
let rec;
async function listen(btn) {
  const label = btn.dataset.label ??= btn.textContent;
  voiceNotice('');
  if (elevenOn() && window.MediaRecorder && navigator.mediaDevices) {
    if (rec?.state === 'recording') return rec.stop();
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return voiceNotice(VOICE.denied); return browserListen(btn, label); }
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = e => chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop()); btn.textContent = label;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); // Safari records audio/mp4, Chrome audio/webm
      const j = await api('/voice/stt', { method: 'POST', body: blob, retry: true }).catch(() => ({}));
      if (j.text?.trim()) return send(j.text);
      voiceNotice(VOICE.missed);
    };
    rec.start(); btn.textContent = 'Stop';
    return;
  }
  browserListen(btn, label);
}
function browserListen(btn, label) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return voiceNotice(VOICE.off);
  const sr = new SR(); sr.lang = 'en-IN';
  sr.onresult = e => send(e.results[0][0].transcript);
  sr.onerror = e => voiceNotice(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? VOICE.denied : VOICE.missed);
  sr.onend = () => (btn.textContent = label);
  try { btn.textContent = 'Listening…'; sr.start(); } catch { btn.textContent = label; voiceNotice(VOICE.off); }
}

// ---------- orders ----------
let draft;
async function extract(btn) {
  $('#draft').innerHTML = '<p class="loading" role="status">Reading the message…</p>';
  try {
    const r = await busy(btn, 'Reading…', () => api('/orders/extract', { method: 'POST', body: { text: $('#otext').value }, retry: true }));
    draft = r.draft;
    const unmatched = draft.items.some(i => !i.product);
    $('#draft').innerHTML = `<div class="sec"><h2>Check this order</h2>
      <p class="lede"><b>${esc(draft.customer.name)}</b> ${draft.customer.isNew ? st('mid', 'New customer') : ''}
        · Delivery <b>${draft.deliveryDate ? esc(day(draft.deliveryDate)) : 'not given'}</b>${draft.deliveryText ? ` <span class="small">from “${esc(draft.deliveryText)}”</span>` : ''}</p>
      ${table([['Asked for', i => esc(i.requested), 'lead'], ['Matched product', i => i.product ? esc(i.product.name) : st('heavy', 'No match')], ['Qty', i => i.quantity, 'num big'], ['Price', i => i.product ? inr(i.product.price) : '—', 'num'], ['In stock', i => i.product?.stock ?? '—', 'num']], draft.items)}
      <p class="total">Total <b>${inr(draft.total)}</b></p>
      ${draft.problems.length ? `<p class="warn">${draft.problems.map(esc).join('<br>')}</p>` : ''}
      <div class="acts gap"><button class="btn primary" onclick="confirmOrder(this)" ${unmatched ? 'disabled title="Fix the unmatched items first"' : ''}>Confirm and save</button>${unmatched ? '<span class="small red">Fix the unmatched items in the message first.</span>' : ''}</div></div>`;
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
    const o = r.dbOpportunity;
    $('#sres').innerHTML = `<p class="lede gap">${r.product ? `Matched <b>${esc(r.product.name)}</b>. You pay ${inr(r.product.cost)} and sell at ${inr(r.product.price)}.` : 'Not in your products, so it was searched as typed.'}</p>
      ${r.web.available ? `${r.web.hiddenBlocked ? `<p class="note">${plural(r.web.hiddenBlocked, 'result')} hidden: blocked supplier.</p>` : ''}${table([['Listing', o => o.link ? `<a href="${esc(o.link)}" target="_blank" rel="noopener">${esc(o.title)}</a>` : esc(o.title)], ['Seller', o => esc(o.source)], ['Price', o => inr(o.price), 'num big']], r.web.offers.slice().sort((a, b) => a.price - b.price), 'No online prices found for this product.')}<p class="note">Shop prices online. Check the pack size before comparing with your cost.</p>` : `<p class="note">${esc(r.web.message)}</p>`}
      ${o ? `<p class="lede gap">Best stored quote: <b>${esc(o.best.supplier)}</b> at ${inr(o.best.unitCost)} a unit, ${inr(o.savingPerUnit)} less${o.significant ? '' : '. Too small to switch for'}.</p>` : ''}`;
  } catch (e) { $('#sres').innerHTML = errorBox(e, 'search prices', () => supSearch(btn)); }
}
async function loadMem() {
  let m;
  try { m = await api('/memory'); }
  catch (e) { if ($('#mem')) $('#mem').innerHTML = errorBox(e, 'load what Nivara remembers', loadMem); return; }
  if ($('#mem')) $('#mem').innerHTML = m.preferences.length ? `<ul class="rows">${m.preferences.map(p => row({ level: null, name: `“${esc(p.text)}”`,
    why: p.kind === 'block_supplier' && p.supplier ? `Won't suggest ${esc(p.supplier)}` : 'Saved note' })).join('')}</ul>` : '<p class="empty">Nothing remembered yet.</p>';
}
async function saveMem(btn) {
  try { await busy(btn, 'Saving…', () => api('/memory', { method: 'POST', body: { text: $('#mtext').value } })); flash = 'Remembered.'; route(); }
  catch (e) { showError(btn, errorBox(e, 'save that', () => saveMem(btn))); }
}

// ---------- workflows / traces ----------
const STEP = {
  forecast: { title: 'Forecast', view: s => `<p>${s.runsOutFirst ? `${plural(s.runsOutFirst, 'product')} run out before new stock can arrive.` : 'Nothing runs out before new stock can arrive.'}</p>` },
  lowStockCheck: { title: 'Low stock', view: s => s.items.length
    ? `<ul class="rows">${s.items.map(i => row({ level: LEVEL[i.risk], name: esc(i.name), why: RISK_WHY[i.risk] ?? '', fig: i.reorderQty ? `<b>${i.reorderQty}</b><span>to order</span>` : '' })).join('')}</ul>`
    : '<p class="empty">Nothing runs out this week.</p>' },
  supplierRefresh: { title: 'Online prices', view: s => s.status === 'skipped' ? '<p class="note">Skipped this time. Your stored quotes still apply.</p>'
    : s.status === 'off' ? '<p class="note">Online prices are not set up. Your stored quotes still apply.</p>'
    : `<ul class="rows">${s.items.map(p => row({ level: null, name: esc(p.product), why: p.missed ? 'No price this time' : p.cheapest ? `${esc(p.cheapest.source)} · ${plural(p.listings, 'listing')}` : 'No prices found',
      fig: p.cheapest ? `<b>${inr(p.cheapest.price)}</b><span>cheapest</span>` : '' })).join('')}</ul>` },
  dailyBrief: { title: 'Brief', view: s => `<div class="a">${answerHtml(s.text)}</div>` },
};
const RISK_WHY = { high: 'Runs out before new stock can arrive', medium: 'Runs out this week' };
function runResult(name, r) {
  const steps = Object.keys(STEP).filter(k => r.steps?.[k]).map(k => [k, r.steps[k]]);
  return `<article class="run" aria-labelledby="run-h">
    <h3 id="run-h">${esc(WF[name] ?? r.label ?? 'Job')}</h3>
    <p class="meta"><span>${r.done ? st('light', 'Done') : st('mid', 'Still running')}</span></p>
    ${r.done ? '' : `<p class="note">${esc(r.message || 'Still running. Check back in a minute.')}</p>`}
    ${steps.map(([k, s]) => `<section class="step"><h4>${STEP[k].title}</h4>${STEP[k].view(s)}</section>`).join('')}</article>`;
}
async function runWf(name, btn) {
  const out = $('#wfout');
  out.innerHTML = `<p class="note" role="status">Running ${esc((WF[name] ?? 'the job').toLowerCase())}…</p>`;
  try {
    const r = await busy(btn, 'Running…', () => api(`/workflows/${name}/run`, { method: 'POST', timeoutMs: API.longTimeoutMs }));
    if (location.hash === '#dashboard' || !location.hash) { flash = `${WF[name] ?? 'Job'} done.`; return route(); }
    out.innerHTML = runResult(name, r);
  } catch (e) { out.innerHTML = errorBox(e, `run the ${(WF[name] ?? 'job').toLowerCase()}`, () => runWf(name, btn)); }
}

// ---------- router ----------
let first = true;
async function route() {
  const [view] = location.hash.slice(1).split('/');
  const name = TITLES[view] ? view : 'dashboard';
  document.querySelectorAll('.nav a').forEach(a => a.hash === '#' + name ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  document.title = `${TITLES[name]} · Nivara`;
  const note = flash; flash = '';
  retries.clear(); lazyOff();
  $('#view').innerHTML = '<p class="loading" role="status">Loading…</p>';
  try {
    $('#view').innerHTML = (note ? `<p class="flash" role="status">${st('light', 'Done')} ${esc(note)}</p>` : '') + await views[name]();
    lazyArm($('#view'));
    if (name === 'suppliers') loadMem();
  } catch (e) { $('#view').innerHTML = `<div class="sec">${errorBox(e, `load ${TITLES[name]}`, route)}</div>`; }
  if (!first) { scrollTo(0, 0); const h = $('#view h1'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); } }
  first = false;
}
addEventListener('hashchange', route);
const markScrolled = () => document.documentElement.classList.toggle('scrolled', scrollY > 4);
addEventListener('scroll', markScrolled, { passive: true }); markScrolled();
addEventListener('online', () => { if (document.querySelector('[data-err]')) route(); }); // back online: reload the page that failed
// The first page and the health check load side by side; health only gates voice, read when a button is pressed.
route();
api('/health').then(h => { health ??= h; }).catch(() => {});
