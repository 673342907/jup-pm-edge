// pm-edge dashboard. Vanilla ES modules, no build step. Pricing and safety rules are the SAME TypeScript
// modules the CLI and server use, served with types stripped (/lib/*.js) or inlined into the static demo.
import * as P from './lib/pricing.js';
import * as S from './lib/safety.js';
import * as W from './wallet.js';

const DEMO = window.__PM_EDGE_DEMO__ || null; // static demo: embedded scan, no server
const JUP = 'https://api.jup.ag/prediction/v1';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (x, d = 2) => (x == null || !isFinite(x) ? '—' : `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(d)}`);
const pct = (x, d = 2) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const cents = (x) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(2)}¢`);
const day = (s) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : '—');
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
const b64ToBytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
const bytesToB64 = (u) => btoa(String.fromCharCode(...u));

const state = {
  report: null,
  source: '',
  tab: 'sets',
  view: 'genuine',
  q: '',
  kind: 'all',
  provider: 'all',
  sort: { key: 'net', dir: -1 },
  limit: 100,
  open: new Set(),
  session: null, // connected wallet session
  watchKey: '',
  mode: 'dry-run',
  route: DEMO ? 'browser' : 'server',
  rpc: 'https://api.mainnet-beta.solana.com',
  drawer: null,
};

// ---------- data ----------
async function load() {
  if (DEMO) {
    state.report = DEMO.report;
    state.source = 'embedded snapshot';
  } else {
    const r = await fetch('/api/scan/latest');
    if (r.ok) {
      const j = await r.json();
      state.report = j.report;
      state.source = j.source;
    }
  }
  render();
}

const rows = () => {
  const s = state.report?.scan;
  if (!s) return [];
  return state.view === 'traps' ? s.traps || [] : state.view === 'unverified' ? s.unverified || [] : s.verified || [];
};

function trapReason(v) {
  const n = v.exclusivity.note || '';
  if (/negRiskAugmented=true|NOT exhaustive/.test(n)) return 'non-exhaustive';
  if (/not mutually exclusive/.test(n)) return 'not-exclusive';
  if (/missing/.test(n)) return 'missing-outcome';
  return v.verdict === 'UNVERIFIED' ? 'unverified' : 'other';
}
const REASON_TEXT = {
  'non-exhaustive': 'The source venue marks this event <b>negRiskAugmented</b>: placeholder outcomes ("Other", "Team A", …) can still win. Every listed outcome can resolve NO, so the YES basket can expire <b>worthless</b>.',
  'not-exclusive': 'These outcomes are <b>not mutually exclusive</b> (cumulative "by date…" ladders, win totals, overlapping brackets). Several can resolve YES, or none can, so buying all of them guarantees nothing.',
  'missing-outcome': 'Jupiter does not list every open outcome of the source event, so the basket is missing at least one way to lose.',
  unverified: 'The venue does not publish an exhaustiveness guarantee (Kalshi has no such flag), so pm-edge refuses to call this a complete set.',
  other: 'The source venue does not confirm this is a complete set.',
};

function metric(v, key) {
  const c = v.candidate;
  switch (key) {
    case 'net': return v.sized?.netProfit ?? -Infinity;
    case 'roi': return v.sized?.roi ?? -Infinity;
    case 'apr': return v.sized?.apr ?? -Infinity;
    case 'quoted': return c.quotedCost / c.payout;
    case 'book': return v.bookCost == null ? Infinity : v.bookCost / c.payout;
    case 'edge': return (c.payout - c.quotedCost) / c.payout;
    case 'legs': return c.legs.length;
    case 'close': return c.closeTime ?? Infinity;
    case 'fees': return v.sized?.fees ?? Infinity;
    default: return 0;
  }
}

function filtered() {
  const q = state.q.toLowerCase();
  let r = rows().filter((v) => (state.kind === 'all' || v.candidate.kind === state.kind) && (state.provider === 'all' || v.candidate.provider === state.provider) && (!q || `${v.candidate.eventTitle} ${v.candidate.eventId} ${v.candidate.legs.map((l) => l.title).join(' ')}`.toLowerCase().includes(q)));
  const { key, dir } = state.sort;
  return [...r].sort((a, b) => (metric(a, key) - metric(b, key)) * dir);
}

// ---------- render ----------
function render() {
  const s = state.report?.scan;
  const badge = $('#mode-badge');
  badge.className = `badge ${DEMO ? 'demo' : state.mode === 'live' ? 'live' : 'dry'}`;
  badge.textContent = DEMO ? `Static demo · ${state.mode === 'live' ? 'LIVE signing' : 'dry-run'}` : state.mode === 'live' ? 'LIVE wallet signing' : 'Dry-run · nothing is signed';
  renderWallet();
  if (DEMO) {
    const b = $('#banner');
    b.hidden = false;
    b.innerHTML = `Static demo with the live scan from <b>${esc(s?.generatedAt)}</b> embedded. Everything is interactive: filters, trap breakdowns, stake calculator on the captured books, and the full pre-sign review + dry-run flow. "Build unsigned orders" calls Jupiter from <i>your</i> browser (Jupiter blocks US/KR IPs).`;
  }
  $('#run-scan').hidden = !!DEMO;
  if (!s) {
    $('#view').innerHTML = '<p class="muted">No scan loaded. Click "Run live scan".</p>';
    return;
  }
  $('#scan-meta').textContent = `scan ${s.generatedAt.replace('T', ' ').slice(0, 16)} UTC · ${state.source}`;
  renderKpis(s);
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'sets') renderSets();
  else if (state.tab === 'parity') renderParity();
  else renderAbout();
}

function parityRate() {
  const rows = state.report?.integrity?.rows?.filter((r) => r.buyDiffCents != null) || [];
  if (!rows.length) return null;
  return rows.filter((r) => Math.abs(r.buyDiffCents) <= 1 && (r.sellDiffCents == null || Math.abs(r.sellDiffCents) <= 1)).length / rows.length;
}

function renderKpis(s) {
  const st = s.stats;
  const arbs = s.verified.filter((v) => v.verdict === 'ARB').length;
  const par = parityRate();
  const n = state.report?.integrity?.rows?.filter((r) => r.buyDiffCents != null).length ?? 0;
  $('#kpis').innerHTML = [
    ['', st.events.toLocaleString(), 'events scanned', `${Object.values(st.candidates).reduce((a, b) => a + b, 0).toLocaleString()} baskets built`],
    ['', st.openMarkets.toLocaleString(), 'open markets', `${st.markets.toLocaleString()} total`],
    [arbs ? 'ok' : '', arbs, 'verified arbs', `of ${st.bookChecked ?? s.verified.length} genuine sets on live books`],
    ['bad', (st.traps ?? 0).toLocaleString(), 'trap baskets rejected', `${(st.naiveFalsePositives ?? 0).toLocaleString()} look like free money to a naive bot`],
    ['acc', par == null ? '—' : pct(par, 1), 'venue parity pass', n ? `Jupiter within ±1¢ of Polymarket/Kalshi · n=${n}` : 'run with integrity sample'],
  ].map(([c, v, l, sub]) => `<div class="kpi ${c}"><div class="n">${v}</div><div class="l">${l}</div><div class="s">${sub}</div></div>`).join('');
}

function th(label, key, cls = '') {
  const on = state.sort.key === key;
  return `<th class="sort ${cls}" data-sort="${key}">${label} ${on ? `<span class="arr">${state.sort.dir < 0 ? '▼' : '▲'}</span>` : ''}</th>`;
}

function renderSets() {
  const s = state.report.scan;
  const all = rows();
  const kinds = [...new Set(all.map((v) => v.candidate.kind))];
  const provs = [...new Set(all.map((v) => v.candidate.provider))];
  const list = filtered();
  const genuine = state.view === 'genuine';
  const body = list.slice(0, state.limit).map((v) => rowHtml(v, genuine)).join('');
  $('#view').innerHTML = `
  <div class="toolbar">
    <div class="seg" id="viewseg">
      <button data-view="genuine" class="${genuine ? 'on gen' : ''}">Genuine sets · ${s.verified.length}</button>
      <button data-view="traps" class="${state.view === 'traps' ? 'on trap' : ''}">Rejected traps · ${(s.traps || []).length}</button>
      <button data-view="unverified" class="${state.view === 'unverified' ? 'on' : ''}">Unverified · ${(s.unverified || []).length}</button>
    </div>
    <input type="search" id="q" placeholder="Search event, market, id…" value="${esc(state.q)}">
    <select id="kind"><option value="all">All kinds</option>${kinds.map((k) => `<option ${k === state.kind ? 'selected' : ''}>${k}</option>`).join('')}</select>
    <select id="prov"><option value="all">All venues</option>${provs.map((k) => `<option ${k === state.provider ? 'selected' : ''}>${k}</option>`).join('')}</select>
    <span class="muted">${list.length.toLocaleString()} rows</span>
  </div>
  ${state.view === 'traps' ? `<div class="reason">These <b>${(s.traps || []).length}</b> baskets look mispriced on quotes, but the source venue says they are <b>not complete sets</b>. ${s.stats.naiveFalsePositives ?? ''} of them cost less than their payout, so a naive "sum of prices &lt; $1" bot buys them and can lose its entire stake. pm-edge hard-blocks them from execution. By reason: ${Object.entries(s.stats.trapReasons || {}).map(([k, n]) => `<b>${k}</b> ${n}`).join(' · ')}.</div>` : ''}
  <div class="grid"><table>
    <thead><tr><th class="l">verdict</th><th class="l">kind</th><th class="l">event / market</th>${th('legs', 'legs')}${th('quoted', 'quoted')}${genuine ? th('book', 'book') : th('naive edge', 'edge')}<th>payout</th>${genuine ? th('fees', 'fees') + th('net', 'net') + th('ROI', 'roi') + th('APR', 'apr') : '<th class="l">why rejected</th>'}${th('closes', 'close')}<th></th></tr></thead>
    <tbody>${body || '<tr><td colspan="13" class="l muted">No rows match.</td></tr>'}</tbody>
  </table></div>
  ${list.length > state.limit ? `<div class="more"><button class="btn" id="more">Show more (${(list.length - state.limit).toLocaleString()} left)</button></div>` : ''}`;
}

function rowHtml(v, genuine) {
  const c = v.candidate;
  const open = state.open.has(c.id);
  const title = `${esc(c.eventTitle)}${c.kind === 'binary-yes-no' ? ` <span class="sm">· ${esc(c.legs[0].title)}</span>` : ''}`;
  const net = v.sized?.netProfit;
  const reason = trapReason(v);
  const main = `<tr class="row" data-id="${esc(c.id)}">
    <td class="l"><span class="tag t-${v.verdict}">${v.verdict}</span></td>
    <td class="l sm">${c.kind}</td>
    <td class="l"><div class="ev">${title}</div><div class="sm">${esc(c.eventId)} · ${c.provider}</div></td>
    <td>${c.legs.length}</td><td>${usd(c.quotedCost, 3)}</td>
    ${genuine ? `<td>${usd(v.bookCost, 3)}</td>` : `<td class="${c.quotedCost < c.payout ? 'pos' : ''}">${pct((c.payout - c.quotedCost) / c.payout, 1)}</td>`}
    <td>${usd(c.payout, 0)}</td>
    ${genuine ? `<td>${usd(v.sized?.fees)}</td><td class="${net > 0 ? 'pos' : net < 0 ? 'neg' : ''}"><b>${usd(net)}</b></td><td>${pct(v.sized?.roi)}</td><td>${pct(v.sized?.apr, 1)}</td>` : `<td class="l sm" style="max-width:360px">${esc(reason)}</td>`}
    <td class="sm">${day(c.closeTime)}</td>
    <td><button class="btn sm ${v.verdict === 'NOT-A-COMPLETE-SET' ? '' : 'primary'}" data-open="${esc(c.id)}">${v.verdict === 'NOT-A-COMPLETE-SET' ? 'Inspect' : 'Trade / simulate'}</button></td></tr>`;
  if (!open) return main;
  const legs = c.legs.map((l, i) => {
    const best = v.asks?.[i]?.[0]?.price;
    return `<tr><td class="l">${esc(l.title)}</td><td class="l"><code>${esc(l.marketId)}</code></td><td class="l"><b>${l.side.toUpperCase()}</b></td><td>${usd(l.quote, 3)}</td><td>${best == null ? '—' : usd(best, 3)}</td><td>${best == null ? '—' : cents((l.quote - best) * 100)}</td></tr>`;
  }).join('');
  const why = v.verdict === 'NOT-A-COMPLETE-SET' || v.verdict === 'UNVERIFIED'
    ? `<div class="reason ${v.verdict === 'UNVERIFIED' ? 'warn' : ''}"><b>Why naive bots lose money here:</b> ${REASON_TEXT[reason]}<br>A naive bot pays <b>${usd(c.quotedCost, 3)}</b> per basket for a "guaranteed" ${usd(c.payout, 0)}; the worst case is <b>${usd(c.kind === 'multi-outcome-no' ? Math.max(0, c.payout - 1) : 0, 0)}</b>.<div class="sm" style="margin-top:6px">Source check: ${esc(v.exclusivity.note)}</div></div>`
    : `<div class="reason ok"><b>${esc(v.exclusivity.status)}</b>: ${esc(v.exclusivity.note)}${v.sized ? ` · best size ${v.sized.contracts.toFixed(2)} sets, gross ${usd(v.sized.grossCost)}, fees ${usd(v.sized.fees)}` : ''}</div>`;
  return main + `<tr class="expand"><td colspan="13">${why}<table class="legs"><thead><tr><th class="l">leg</th><th class="l">market</th><th class="l">side</th><th>Jupiter quote</th><th>book best ask</th><th>quote − book</th></tr></thead><tbody>${legs}</tbody></table></td></tr>`;
}

function renderParity() {
  const integ = state.report.integrity;
  if (!integ) {
    $('#view').innerHTML = '<p class="muted">This scan has no integrity sample. Run with --integrity-sample.</p>';
    return;
  }
  const rows = [...integ.rows].sort((a, b) => Math.abs(b.buyDiffCents ?? 0) - Math.abs(a.buyDiffCents ?? 0));
  $('#view').innerHTML = `
  <p class="muted">Jupiter's quoted buy/sell YES vs the live best ask/bid on the native venue (Polymarket CLOB, Kalshi order book), for the most-traded markets. Positive = trading through Jupiter costs more.</p>
  <div class="kpis">${integ.summary.map((x) => `<div class="kpi ${x.withinOneCentPct >= 95 ? 'ok' : 'bad'}"><div class="n">${x.withinOneCentPct ?? '—'}%</div><div class="l">${esc(x.provider)} within ±1¢</div><div class="s">n=${x.n} · median buy ${cents(x.medianBuyDiffCents)} · worst ${cents(x.worstBuyDiffCents)}</div></div>`).join('')}</div>
  <div class="grid"><table><thead><tr><th class="l">market</th><th class="l">venue</th><th>Jupiter buy</th><th>venue ask</th><th>Δ buy</th><th>Jupiter sell</th><th>venue bid</th><th>Δ sell</th><th class="l">status</th></tr></thead><tbody>
  ${rows.map((r) => { const ok = r.buyDiffCents != null && Math.abs(r.buyDiffCents) <= 1 && (r.sellDiffCents == null || Math.abs(r.sellDiffCents) <= 1); return `<tr><td class="l"><div class="ev">${esc(r.title)}</div><div class="sm"><code>${esc(r.marketId)}</code></div></td><td class="l">${esc(r.provider)}</td><td>${usd(r.jupBuyYes, 3)}</td><td>${usd(r.venueAsk, 3)}</td><td>${cents(r.buyDiffCents)}</td><td>${usd(r.jupSellYes, 3)}</td><td>${usd(r.venueBid, 3)}</td><td>${cents(r.sellDiffCents)}</td><td class="l">${r.error ? `<span class="tag t-UNVERIFIED">error</span> <span class="sm">${esc(r.error)}</span>` : ok ? '<span class="tag t-ARB">PASS</span>' : '<span class="tag t-NOT-A-COMPLETE-SET">DRIFT</span>'}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function renderAbout() {
  $('#view').innerHTML = `<div class="grid" style="padding:18px 22px;max-width:980px">
  <h3>What a judge can test in 30 seconds</h3>
  <ol><li>Toggle <b>Rejected traps</b> and expand a row: see why a naive bot loses.</li><li>Open a genuine set, slide the stake from $25 to $500, and watch depth plus Jupiter's fee curve change net P&amp;L.</li><li>Click <b>Use watch-only demo key</b>, then <b>Build unsigned orders</b> → <b>Simulate</b>. No wallet, no funds, nothing signed.</li><li>Try executing a trap: the review hard-blocks it.</li></ol>
  <h3>Safety model</h3>
  <ul>
  <li><b>No keys, ever.</b> The browser wallet signs. The server never sees a key, and the dashboard never asks for one.</li>
  <li><b>Trap baskets are hard-blocked.</b> In live mode, always. In dry-run, you can inspect the payload only after ticking "inspect trap", and it can never be signed. The server re-runs the same review against its own scan, so a modified client cannot bypass it.</li>
  <li><b>Live signing is priced on live books</b>, never a stale snapshot. Each leg must be ≥ $5 (Jupiter minimum), stake ≤ hard cap, and a negative-edge basket needs an explicit acknowledgement.</li>
  <li><b>Transaction check before every prompt:</b> the unsigned tx is decoded in the browser, and its fee payer and required signers must be your wallet.</li>
  <li><b>Dry-run</b> simulates with RPC <code>simulateTransaction</code> (sigVerify off), so zero funds are spent. <b>Live</b> asks the wallet to sign each leg and relays it to Jupiter <code>/execute</code>. Legs are separate transactions: partial-fill risk is shown before signing.</li>
  </ul>
  <h3>Data</h3><p class="muted">Jupiter Prediction API (events, order books, POST /orders, /execute) · Polymarket gamma + CLOB · Kalshi trade API. Fees: ceil_to_cent(0.07·C·p·(1−p)), which reproduces Jupiter's published table exactly.</p></div>`;
}

// ---------- wallet ----------
let walletMenu = false;
function renderWallet() {
  const s = state.session;
  const ws = W.list();
  $('#wallet-area').innerHTML = `<div class="wallets">${s ? `<button class="btn" id="wdisc">● ${esc(s.name)} ${short(s.address)}</button>` : `<button class="btn primary" id="wbtn">Connect wallet</button>`}
  ${walletMenu && !s ? `<div class="wmenu">${ws.length ? ws.map((w) => `<button class="btn" data-wallet="${esc(w.name)}">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}${esc(w.name)}</button>`).join('') : '<div class="note">No Solana wallet detected. Install Phantom or Solflare, or use a watch-only key in the trade drawer for dry-run.</div>'}<div class="note">The wallet signs. pm-edge never sees or stores keys.</div></div>` : ''}</div>`;
}

// ---------- drawer: stake calculator + safety review + execution ----------
async function openDrawer(id) {
  const v = [...(state.report.scan.verified || []), ...(state.report.scan.traps || []), ...(state.report.scan.unverified || [])].find((x) => x.candidate.id === id);
  if (!v) return;
  state.drawer = { v, stake: Math.max(25, Math.min(500, Math.ceil((v.sized?.grossCost ?? 100) + (v.sized?.fees ?? 0)))), quote: null, asks: v.asks || null, source: v.asks ? 'scan snapshot' : 'none', ackTrap: false, ackLoss: false, built: null, log: [], busy: false };
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  renderDrawer();
  requote(); // snapshot first (instant), then live books: traps too, so you see what a naive bot would pay
  await refreshBooks();
}
function closeDrawer() {
  state.drawer = null;
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
}
function log(msg, obj) {
  state.drawer.log.push(`[${new Date().toISOString().slice(11, 19)}] ${msg}${obj !== undefined ? '\n' + (typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)) : ''}`);
  renderDrawer();
}

async function refreshBooks() {
  const d = state.drawer;
  d.busy = true;
  renderDrawer();
  try {
    if (state.route === 'server' && !DEMO) {
      const r = await fetch(`/api/basket/${encodeURIComponent(d.v.candidate.id)}/quote?stake=${d.stake}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      d.asks = j.asks;
      d.source = j.source === 'live' ? `live books via local server · ${j.fetchedAt.slice(11, 19)} UTC` : `scan snapshot (live fetch failed: ${j.error})`;
    } else {
      const books = await Promise.all(d.v.candidate.legs.map((l) => fetch(`${JUP}/orderbook/${encodeURIComponent(l.marketId)}`).then((r) => { if (!r.ok) throw new Error(`orderbook HTTP ${r.status}`); return r.json(); })));
      d.asks = books.map((b, i) => P.askLadder(P.parseJupOrderbook(b), d.v.candidate.legs[i].side));
      d.source = `live books from your browser · ${new Date().toISOString().slice(11, 19)} UTC`;
    }
  } catch (e) {
    d.source = d.v.asks ? `scan snapshot (live fetch failed: ${e.message})` : `no books (${e.message})`;
    d.asks = d.v.asks || null;
  }
  d.busy = false;
  requote();
}

function requote() {
  const d = state.drawer;
  d.quote = d.asks ? P.quoteStake(d.asks, d.v.candidate.payout, d.stake, { closeTime: d.v.candidate.closeTime }) : null;
  d.built = null;
  renderDrawer();
}

const owner = () => state.session?.address || state.watchKey;
function review() {
  const d = state.drawer;
  return S.reviewExecution({
    mode: state.mode,
    ownerPubkey: owner() || '',
    verdict: d.v.verdict,
    exclusivityStatus: d.v.exclusivity.status,
    exclusivityNote: d.v.exclusivity.note,
    stakeUsd: d.stake,
    maxStakeUsd: 1000,
    quote: d.quote && (state.mode === 'live' && !/^live/.test(d.source) ? null : d.quote),
    acknowledgeTrap: d.ackTrap,
    acknowledgeLoss: d.ackLoss,
  });
}

function renderDrawer() {
  const d = state.drawer;
  if (!d) return;
  const c = d.v.candidate;
  const q = d.quote;
  const rv = review();
  const live = state.mode === 'live';
  const legRows = q ? c.legs.map((l, i) => `<tr><td class="l">${esc(l.title)} <b>${l.side.toUpperCase()}</b><div class="sm"><code>${esc(l.marketId)}</code></div></td><td>${usd(q.legs[i].bestAsk, 3)}</td><td>${usd(q.legs[i].avgPrice, 4)}</td><td>${cents(q.legs[i].slippageCents)}</td><td>${usd(q.legs[i].cost)}</td><td>${usd(q.legs[i].fee)}</td><td class="${q.legs[i].deposit < 5 ? 'neg' : ''}">${usd(q.legs[i].deposit)}</td></tr>`).join('') : '';
  const builtActions = d.built?.legs?.some((l) => l.transaction);
  $('#drawer').innerHTML = `
  <button class="btn sm close" id="dclose">✕ Close</button>
  <span class="tag t-${d.v.verdict}">${d.v.verdict}</span> <span class="sm">${c.kind} · ${c.provider} · closes ${day(c.closeTime)}</span>
  <h2>${esc(c.eventTitle)}</h2><div class="sm"><code>${esc(c.id.length > 90 ? c.id.slice(0, 90) + '…' : c.id)}</code></div>

  <h3>Live order book &amp; slippage calculator</h3>
  <div class="stake"><span>Stake</span><input type="range" id="stake" min="25" max="500" step="5" value="${d.stake}"><input type="number" id="stakeN" min="5" max="1000" value="${d.stake}" style="width:90px"> <span class="sm">USDC incl. fees</span> <button class="btn sm" id="refresh" ${d.busy ? 'disabled' : ''}>${d.busy ? 'Fetching…' : '↻ Live books'}</button></div>
  <div class="sm" style="margin-top:6px">${d.busy ? '<span class="spark"></span>' : ''}Source: ${esc(d.source)}</div>
  ${q ? `<table class="legs" style="width:100%;margin-top:8px"><thead><tr><th class="l">leg</th><th>best ask</th><th>avg fill</th><th>slippage</th><th>cost</th><th>Jupiter fee</th><th>deposit</th></tr></thead><tbody>${legRows}</tbody></table>
  <div class="totals"><div>sets<b>${q.contracts.toFixed(2)}</b></div><div>total cost<b>${usd(q.totalCost)}</b><span class="sm">fees ${usd(q.fees)}</span></div>${d.v.verdict === 'NOT-A-COMPLETE-SET'
    ? `<div>payout at resolution<b class="neg">NOT guaranteed</b><span class="sm">naive bot assumes ${usd(q.payoutUsd)}</span></div><div>worst case<b class="neg">${usd(-q.totalCost)}</b><span class="sm">"+${usd(q.netProfit)}" is the illusion a naive bot sees</span></div></div>`
    : `<div>payout at resolution<b>${usd(q.payoutUsd)}</b></div><div>net P&amp;L<b class="${q.netProfit > 0 ? 'pos' : 'neg'}">${usd(q.netProfit)}</b><span class="sm">ROI ${pct(q.roi)} · APR ${pct(q.apr, 1)}</span></div></div>`}
  ${q.depthLimited ? '<div class="note">Book depth limits the size below your stake.</div>' : ''}` : '<p class="muted">No fillable depth for this basket on the current books.</p>'}

  <h3>Execution</h3>
  <div class="modebox">
    <div class="row2"><div class="seg" id="modeseg"><button data-mode="dry-run" class="${!live ? 'on gen' : ''}">Dry-run (simulate, nothing signed)</button><button data-mode="live" class="${live ? 'on trap' : ''}">Live wallet signing</button></div>
    <div class="seg" id="routeseg" title="Who calls Jupiter"><button data-route="browser" class="${state.route === 'browser' ? 'on' : ''}">Build from browser</button>${DEMO ? '' : `<button data-route="server" class="${state.route === 'server' ? 'on' : ''}">via local server</button>`}</div></div>
    <div class="row2" style="margin-top:8px">${state.session ? `<span>Wallet <b>${esc(state.session.name)}</b> <code>${esc(state.session.address)}</code></span>` : `<input id="watch" placeholder="watch-only public key for dry-run" value="${esc(state.watchKey)}" style="flex:1"><button class="btn sm" id="demokey">Use watch-only demo key</button>`}</div>
    ${d.v.verdict === 'NOT-A-COMPLETE-SET' || d.v.verdict === 'UNVERIFIED' ? `<label class="row2" style="margin-top:8px"><input type="checkbox" id="acktrap" ${d.ackTrap ? 'checked' : ''} ${live ? 'disabled' : ''}> Inspect this ${d.v.verdict === 'UNVERIFIED' ? 'unverified basket' : 'TRAP'} in dry-run (payload preview only, can never be signed)</label>` : ''}
    ${live && q && q.netProfit <= 0 ? `<label class="row2" style="margin-top:8px"><input type="checkbox" id="ackloss" ${d.ackLoss ? 'checked' : ''}> I understand this basket loses ${usd(-q.netProfit)} after fees</label>` : ''}
  </div>

  <h3>Pre-sign safety review ${rv.canSign ? '<span class="tag t-ARB">READY TO SIGN</span>' : rv.canBuildUnsigned ? '<span class="tag t-NO-EDGE-AFTER-FEES">DRY-RUN OK</span>' : rv.previewOnly ? '<span class="tag t-UNVERIFIED">PREVIEW ONLY</span>' : '<span class="tag t-NOT-A-COMPLETE-SET">BLOCKED</span>'}</h3>
  <ul class="checks">${rv.checks.map((k) => `<li class="${k.status}"><span class="ico">${k.status === 'pass' ? '✓' : k.status === 'warn' ? '!' : '✕'}</span><span><b>${esc(k.name)}</b>: ${esc(k.detail)}</span></li>`).join('')}
  ${(d.built?.legs || []).map((l, i) => l.txCheck ? `<li class="${l.txCheck.status}"><span class="ico">${l.txCheck.status === 'pass' ? '✓' : l.txCheck.status === 'warn' ? '!' : '✕'}</span><span><b>leg ${i + 1} tx</b>: ${esc(l.txCheck.detail)}</span></li>` : '').join('')}</ul>
  <ul class="note">${rv.warnings.slice(-3).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
  <div class="row2">
    <button class="btn ${rv.previewOnly ? '' : 'primary'}" id="build" ${rv.canBuildUnsigned || rv.previewOnly ? '' : 'disabled'}>${rv.previewOnly ? 'Preview order payload' : 'Build unsigned orders'}</button>
    <button class="btn ok" id="simulate" ${builtActions && !live ? '' : 'disabled'}>Simulate (dry-run)</button>
    <button class="btn danger" id="sign" ${builtActions && rv.canSign && d.built.legs.every((l) => l.txCheck?.status !== 'block') ? '' : 'disabled'}>Sign &amp; execute ${c.legs.length} leg${c.legs.length > 1 ? 's' : ''} (LIVE)</button>
  </div>
  <h3>Activity</h3><div class="log" id="log">${esc(d.log.join('\n\n')) || 'Nothing yet. Every step is logged here.'}</div>`;
  const lg = $('#log');
  if (lg) lg.scrollTop = lg.scrollHeight;
}

async function build() {
  const d = state.drawer;
  const rv = review();
  if (!rv.canBuildUnsigned && !rv.previewOnly) return log('Blocked by safety review', rv.blockers);
  const legsAsks = d.quote.legs.map((l) => l.deposit);
  const bodies = d.v.candidate.legs.map((l, i) => ({ ownerPubkey: owner(), marketId: l.marketId, isYes: l.side === 'yes', isBuy: true, depositAmount: String(Math.ceil(legsAsks[i] * 1e6 - 1e-6)), depositMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }));
  if (rv.previewOnly) {
    d.built = { previewOnly: true, legs: bodies.map((request) => ({ request })) };
    return log('PAYLOAD PREVIEW ONLY: Jupiter was not called, and this basket can never be signed. POST /prediction/v1/orders bodies:', bodies);
  }
  log(`Requesting ${bodies.length} UNSIGNED order transaction(s) from Jupiter via ${state.route === 'server' ? 'local server' : 'your browser'}…`);
  if (state.route === 'server' && !DEMO) {
    const r = await fetch('/api/orders/build', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ basketId: d.v.candidate.id, ownerPubkey: owner(), stakeUsd: d.stake, mode: state.mode, acknowledgeTrap: d.ackTrap, acknowledgeLoss: d.ackLoss }) });
    const j = await r.json();
    if (!r.ok) return log(`Server refused (${r.status}): ${j.error}`, j.review?.blockers);
    d.built = j;
  } else {
    const legs = [];
    for (const request of bodies) {
      try {
        const r = await fetch(`${JUP}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
        const j = await r.json();
        if (!r.ok) legs.push({ request, error: { status: r.status, code: j.code, message: j.message } });
        else legs.push({ request, transaction: j.transaction, txMeta: j.txMeta, execution: j.execution, order: j.order, txCheck: S.checkUnsignedTx(b64ToBytes(j.transaction), request.ownerPubkey) });
      } catch (e) {
        legs.push({ request, error: { message: e.message } });
      }
    }
    d.built = { legs };
  }
  d.built.legs.forEach((l, i) => {
    if (l.transaction) log(`leg ${i + 1} ✓ unsigned tx (${b64ToBytes(l.transaction).length} bytes) · ${l.txCheck?.detail}`, { request: l.request, order: l.order, transaction: l.transaction.slice(0, 120) + '…' });
    else log(`leg ${i + 1} ✕ Jupiter did not build: ${l.error?.code || ''} ${l.error?.message || ''}${l.error?.code === 'unsupported_region' ? '\n(Jupiter blocks trading from this IP region, e.g. US/KR. Request body shown so the flow stays inspectable.)' : ''}`, l.request);
  });
}

async function simulate() {
  const d = state.drawer;
  for (const [i, l] of d.built.legs.entries()) {
    if (!l.transaction) continue;
    log(`leg ${i + 1}: simulateTransaction (sigVerify=false, replaceRecentBlockhash=true). Nothing is signed or sent.`);
    try {
      let out;
      if (state.route === 'server' && !DEMO) out = await (await fetch('/api/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: l.transaction }) })).json();
      else {
        const r = await (await fetch(state.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [l.transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }] }) })).json();
        out = r.error ? { ok: false, rpcError: r.error } : { ok: r.result.value.err == null, err: r.result.value.err, logs: r.result.value.logs, unitsConsumed: r.result.value.unitsConsumed };
      }
      log(`leg ${i + 1}: ${out.ok ? 'simulation OK' : 'simulation FAILED (expected for an unfunded watch-only key)'}`, out);
    } catch (e) {
      log(`leg ${i + 1}: simulation error ${e.message}`);
    }
  }
}

async function signAndExecute() {
  const d = state.drawer;
  const rv = review();
  if (!rv.canSign || !state.session) return log('Signing blocked by safety review', rv.blockers);
  if (!confirm(`LIVE: sign ${d.built.legs.length} transaction(s) spending up to ${usd(d.quote.totalCost)} USDC from ${state.session.address}?`)) return log('Cancelled by user.');
  for (const [i, l] of d.built.legs.entries()) {
    const check = S.checkUnsignedTx(b64ToBytes(l.transaction), state.session.address);
    if (check.status === 'block') return log(`leg ${i + 1}: ABORT ${check.detail}`);
    try {
      log(`leg ${i + 1}: requesting wallet signature…`);
      if (state.session.canSignOnly) {
        const signed = await state.session.signTransaction(b64ToBytes(l.transaction));
        const body = { signedTransaction: bytesToB64(signed), context: l.execution?.context ?? null };
        const r = state.route === 'server' && !DEMO
          ? await fetch('/api/orders/execute', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
          : await fetch(`${JUP}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const j = await r.json();
        if (!r.ok) throw new Error(JSON.stringify(j));
        log(`leg ${i + 1}: executed via Jupiter /execute`, j);
      } else {
        const sig = await state.session.signAndSend(b64ToBytes(l.transaction));
        const s = typeof sig === 'string' ? sig : S.base58Encode(sig);
        log(`leg ${i + 1}: sent · https://solscan.io/tx/${s}`);
      }
    } catch (e) {
      return log(`leg ${i + 1}: FAILED: ${e.message}. Stopping. Earlier legs may have filled: you may hold a partial position.`);
    }
  }
}

function randomPubkey() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return S.base58Encode(b);
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, tr.row, th.sort');
  if (!t) return;
  if (t.dataset.tab) { state.tab = t.dataset.tab; return render(); }
  if (t.dataset.view) { state.view = t.dataset.view; state.limit = 100; state.sort = { key: t.dataset.view === 'genuine' ? 'net' : 'edge', dir: -1 }; return render(); }
  if (t.dataset.sort) { const k = t.dataset.sort; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 }; return render(); }
  if (t.dataset.open) { e.stopPropagation(); return openDrawer(t.dataset.open); }
  if (t.matches('tr.row')) { const id = t.dataset.id; state.open.has(id) ? state.open.delete(id) : state.open.add(id); return render(); }
  if (t.id === 'more') { state.limit += 200; return render(); }
  if (t.id === 'wbtn') { walletMenu = !walletMenu; return renderWallet(); }
  if (t.dataset.wallet) {
    try { state.session = await W.connect(t.dataset.wallet); walletMenu = false; } catch (err) { alert(`Wallet connection failed: ${err.message}`); }
    render(); return renderDrawer();
  }
  if (t.id === 'wdisc') { await state.session?.disconnect(); state.session = null; state.mode = 'dry-run'; render(); return renderDrawer(); }
  if (t.id === 'run-scan') return runScan();
  if (t.id === 'dclose') return closeDrawer();
  if (t.id === 'refresh') return refreshBooks();
  if (t.dataset.mode) {
    if (t.dataset.mode === 'live' && !state.session) { alert('Connect a wallet for live signing. Dry-run works with a watch-only key.'); return; }
    state.mode = t.dataset.mode; state.drawer.ackTrap = false; state.drawer.built = null; render(); return renderDrawer();
  }
  if (t.dataset.route) { state.route = t.dataset.route; state.drawer.built = null; return refreshBooks(); }
  if (t.id === 'demokey') { state.watchKey = randomPubkey(); return renderDrawer(); }
  if (t.id === 'build') return build();
  if (t.id === 'simulate') return simulate();
  if (t.id === 'sign') return signAndExecute();
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'q') { state.q = t.value; state.limit = 100; renderSets(); const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  if (t.id === 'stake' || t.id === 'stakeN') { state.drawer.stake = Number(t.value); requote(); $(`#${t.id}`)?.focus(); }
  if (t.id === 'watch') { state.watchKey = t.value.trim(); }
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'kind') { state.kind = t.value; renderSets(); }
  if (t.id === 'prov') { state.provider = t.value; renderSets(); }
  if (t.id === 'acktrap') { state.drawer.ackTrap = t.checked; state.drawer.built = null; renderDrawer(); }
  if (t.id === 'ackloss') { state.drawer.ackLoss = t.checked; renderDrawer(); }
  if (t.id === 'watch') renderDrawer();
});
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => e.key === 'Escape' && state.drawer && closeDrawer());

async function runScan() {
  const btn = $('#run-scan');
  btn.disabled = true;
  btn.innerHTML = '<span class="spark"></span>Scanning…';
  const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ maxEvents: 600, integritySample: 20 }) });
  if (r.status !== 202 && r.status !== 409) { btn.disabled = false; btn.textContent = 'Run live scan'; return alert((await r.json()).error); }
  for (;;) {
    await new Promise((res) => setTimeout(res, 2000));
    const s = await (await fetch('/api/scan/status')).json();
    if (!s.scanning) {
      btn.disabled = false;
      btn.textContent = 'Run live scan';
      if (s.lastError) alert(`Scan failed: ${s.lastError}`);
      return load();
    }
  }
}

W.onChange(() => renderWallet());
W.startDiscovery();
// Deep links for demos/screenshots: #view=traps&expand=<id|first>&drawer=<id|first|top>&demokey=1&tab=parity
const hp = new URLSearchParams(location.hash.slice(1));
if (hp.get('view')) state.view = hp.get('view');
if (hp.get('tab')) state.tab = hp.get('tab');
load().then(() => {
  const first = () => filtered()[0]?.candidate.id;
  if (hp.get('expand')) { const id = hp.get('expand') === 'first' ? first() : hp.get('expand'); if (id) { state.open.add(id); render(); } }
  if (hp.get('drawer') === 'top' || hp.get('drawer') === 'first') { const id = first(); if (id) openDrawer(id); }
  else if (hp.get('drawer')) openDrawer(hp.get('drawer'));
  if (hp.get('demokey')) { state.watchKey = randomPubkey(); renderDrawer(); }
});
