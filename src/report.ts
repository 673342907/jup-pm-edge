import type { IntegrityRow } from './types.ts';
import type { IntegritySummary } from './integrity.ts';
import type { ScanResult } from './scan.ts';

const usd = (x: number | null | undefined, d = 2) => (x == null ? '—' : `$${x.toFixed(d)}`);
const pct = (x: number | null | undefined, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const c = (x: number | null | undefined) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(2)}¢`);
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const date = (sec: number | null) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '—');
const shanghai = (iso: string) =>
  new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 16) + ' (UTC+8)';

export interface Report {
  scan: ScanResult;
  integrity?: { rows: IntegrityRow[]; summary: IntegritySummary[] };
}

export function toMarkdown({ scan, integrity }: Report): string {
  const s = scan.stats;
  const arbs = scan.verified.filter((v) => v.verdict === 'ARB');
  const L: string[] = [];
  L.push(`# Jupiter Prediction Markets — complete-set & price-integrity scan`, '');
  L.push(`Generated ${scan.generatedAt} · ${shanghai(scan.generatedAt)}`, '');
  L.push(`## Coverage`, '');
  L.push(`| events | markets | open markets | baskets within screen | source-checked | traps rejected | book-checked |`, `|---:|---:|---:|---:|---:|---:|---:|`);
  L.push(`| ${s.events} | ${s.markets} | ${s.openMarkets} | ${s.screened} | ${s.sourceChecked ?? '—'} | ${s.traps ?? '—'} | ${s.bookChecked ?? '—'} |`, '');
  L.push(`| set kind | baskets | median quoted overround |`, `|---|---:|---:|`);
  for (const k of Object.keys(s.candidates)) L.push(`| ${k} | ${s.candidates[k]} | ${s.medianOverroundPct[k]}% |`);
  L.push('', `## Verified opportunities (${arbs.length} ARB of ${scan.verified.length} checked against live orderbooks)`, '');
  L.push(`| verdict | kind | event | legs | quoted cost | book cost | payout | size | net profit | ROI | APR | closes |`);
  L.push(`|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|`);
  for (const v of scan.verified) {
    const k = v.candidate;
    L.push(`| ${v.verdict} | ${k.kind} | ${k.eventTitle.replace(/\|/g, '/')}${k.kind === 'binary-yes-no' ? ' — ' + k.legs[0]!.title.replace(/\|/g, '/') : ''} (${k.eventId}) | ${k.legs.length} | ${usd(k.quotedCost, 3)} | ${usd(v.bookCost, 3)} | ${usd(k.payout, 0)} | ${v.sized ? v.sized.contracts.toFixed(2) : '—'} | ${usd(v.sized?.netProfit)} | ${pct(v.sized?.roi)} | ${pct(v.sized?.apr, 1)} | ${date(k.closeTime)} |`);
  }
  L.push('', `Structure checks for multi-outcome baskets above:`, '');
  for (const v of scan.verified.filter((x) => x.candidate.kind.startsWith('multi'))) L.push(`- \`${v.candidate.eventId}\` ${v.candidate.kind}: **${v.exclusivity.status}** — ${v.exclusivity.note}`);
  L.push('', `## Traps rejected (${s.traps ?? 0} of ${s.sourceChecked ?? 0} source-checked baskets)`, '');
  L.push(`These look like free money on Jupiter quotes but are **not** complete sets according to the source venue. ${s.naiveFalsePositives ?? 0} of them have quotes summing to less than their payout, i.e. a naive "sum of prices < payout" scanner would flag them as arbitrage. By reason: ${Object.entries(s.trapReasons ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
  L.push(`| kind | event | quoted cost | payout | why rejected |`, `|---|---|---:|---:|---|`);
  for (const v of scan.traps) L.push(`| ${v.candidate.kind} | ${v.candidate.eventTitle.replace(/\|/g, '/')} (${v.candidate.eventId}) | ${usd(v.candidate.quotedCost, 3)} | ${usd(v.candidate.payout, 0)} | ${v.exclusivity.note.replace(/\|/g, '/')} |`);
  if (scan.unverified.length) {
    L.push('', `Unverified (${s.unverified ?? 0}, never counted as ARB):`, '');
    for (const v of scan.unverified) L.push(`- ${v.candidate.kind} ${v.candidate.eventTitle} (${v.candidate.eventId}) quoted ${usd(v.candidate.quotedCost, 3)} — ${v.exclusivity.note}`);
  }
  if (integrity) {
    L.push('', `## Price integrity — Jupiter vs native venue`, '');
    L.push(`Positive buy diff = Jupiter's buy-YES quote is above the venue's best ask. Positive sell diff = Jupiter's sell-YES quote is below the venue's best bid.`, '');
    L.push(`| provider | n | median buy diff | mean buy diff | worst buy diff | median sell diff | within ±1¢ |`, `|---|---:|---:|---:|---:|---:|---:|`);
    for (const r of integrity.summary) L.push(`| ${r.provider} | ${r.n} | ${c(r.medianBuyDiffCents)} | ${c(r.meanBuyDiffCents)} | ${c(r.worstBuyDiffCents)} | ${c(r.medianSellDiffCents)} | ${r.withinOneCentPct ?? '—'}% |`);
    const worst = [...integrity.rows].filter((r) => r.buyDiffCents != null).sort((a, b) => Math.abs(b.buyDiffCents!) - Math.abs(a.buyDiffCents!)).slice(0, 10);
    L.push('', `Largest deviations:`, '', `| market | provider | Jup buy | venue ask | diff | Jup sell | venue bid | diff |`, `|---|---|---:|---:|---:|---:|---:|---:|`);
    for (const r of worst) L.push(`| ${r.marketId} ${r.title.replace(/\|/g, '/')} | ${r.provider} | ${usd(r.jupBuyYes, 3)} | ${usd(r.venueAsk, 3)} | ${c(r.buyDiffCents)} | ${usd(r.jupSellYes, 3)} | ${usd(r.venueBid, 3)} | ${c(r.sellDiffCents)} |`);
  }
  L.push('', `_Read-only analysis. Nothing here signs or sends a transaction. Not financial advice._`, '');
  return L.join('\n');
}

export function toHtml(r: Report): string {
  const { scan, integrity } = r;
  const s = scan.stats;
  const rows = scan.verified
    .map((v) => {
      const k = v.candidate;
      const legs = k.legs.map((l) => `${esc(l.title)} <b>${l.side.toUpperCase()}</b> @ ${l.quote.toFixed(3)}`).join('<br>');
      return `<tr class="${v.verdict}"><td><span class="tag">${v.verdict}</span></td><td>${k.kind}</td><td><div class="ev">${esc(k.eventTitle)}${k.kind === 'binary-yes-no' ? ' — ' + esc(k.legs[0]!.title) : ''}</div><div class="id">${esc(k.eventId)} · ${k.provider} · closes ${date(k.closeTime)}</div><details><summary>${k.legs.length} legs</summary>${legs}<div class="id">${esc(v.exclusivity.status)}: ${esc(v.exclusivity.note)}</div></details></td><td>${usd(k.quotedCost, 3)}</td><td>${usd(v.bookCost, 3)}</td><td>${usd(k.payout, 0)}</td><td>${v.sized ? v.sized.contracts.toFixed(2) : '—'}</td><td>${usd(v.sized?.fees)}</td><td><b>${usd(v.sized?.netProfit)}</b></td><td>${pct(v.sized?.roi)}</td><td>${pct(v.sized?.apr, 1)}</td></tr>`;
    })
    .join('');
  const kinds = Object.keys(s.candidates).map((k) => `<div class="card"><div class="n">${s.candidates[k]}</div><div>${k}</div><div class="id">median overround ${s.medianOverroundPct[k]}%</div></div>`).join('');
  const integ = integrity
    ? `<h2>Price integrity: Jupiter vs native venue</h2><p class="id">Buy diff = Jupiter buy-YES minus venue best ask. Sell diff = venue best bid minus Jupiter sell-YES. Positive = trading via Jupiter costs more.</p><table><tr><th>provider</th><th>n</th><th>median buy</th><th>mean buy</th><th>worst buy</th><th>median sell</th><th>within ±1¢</th></tr>${integrity.summary.map((x) => `<tr><td>${x.provider}</td><td>${x.n}</td><td>${c(x.medianBuyDiffCents)}</td><td>${c(x.meanBuyDiffCents)}</td><td>${c(x.worstBuyDiffCents)}</td><td>${c(x.medianSellDiffCents)}</td><td>${x.withinOneCentPct ?? '—'}%</td></tr>`).join('')}</table>
<details><summary>All ${integrity.rows.length} sampled markets</summary><table><tr><th>market</th><th>prov</th><th>Jup buy</th><th>venue ask</th><th>diff</th><th>Jup sell</th><th>venue bid</th><th>diff</th></tr>${integrity.rows.map((x) => `<tr><td>${esc(x.marketId)}<div class="id">${esc(x.title)}${x.error ? ' · ' + esc(x.error) : ''}</div></td><td>${x.provider}</td><td>${usd(x.jupBuyYes, 3)}</td><td>${usd(x.venueAsk, 3)}</td><td>${c(x.buyDiffCents)}</td><td>${usd(x.jupSellYes, 3)}</td><td>${usd(x.venueBid, 3)}</td><td>${c(x.sellDiffCents)}</td></tr>`).join('')}</table></details>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>pm-edge · Jupiter Prediction scan</title>
<style>:root{--bg:#0b0f14;--fg:#e6edf3;--mut:#8b98a5;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--line:#21262d}
body{background:var(--bg);color:var(--fg);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:28px;max-width:1280px;margin:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}.id{color:var(--mut);font-size:12px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.card{border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:150px}.n{font-size:24px;font-weight:700}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border-bottom:1px solid var(--line);padding:7px 8px;text-align:right;vertical-align:top}th:nth-child(-n+3),td:nth-child(-n+3){text-align:left}
.tag{font-size:11px;font-weight:700;padding:2px 6px;border-radius:6px;background:#30363d}.ARB .tag{background:var(--ok);color:#000}.NO-EDGE-AFTER-FEES .tag{background:#30363d}.NOT-A-COMPLETE-SET .tag,.UNVERIFIED .tag{background:var(--warn);color:#000}
.ev{font-weight:600}details summary{cursor:pointer;color:var(--mut);font-size:12px}</style></head><body>
<h1>pm-edge — Jupiter Prediction Markets scan</h1><div class="id">Generated ${esc(scan.generatedAt)} · ${shanghai(scan.generatedAt)} · read-only, nothing is signed or sent</div>
<div class="cards"><div class="card"><div class="n">${s.events}</div><div>events</div></div><div class="card"><div class="n">${s.openMarkets}</div><div>open markets</div></div><div class="card"><div class="n">${scan.verified.filter((v) => v.verdict === 'ARB').length}</div><div>verified ARB</div><div class="id">of ${s.bookChecked ?? s.screened} genuine sets checked on live books</div></div><div class="card"><div class="n">${s.traps ?? 0}</div><div>traps rejected</div><div class="id">of ${s.sourceChecked ?? 0} source-checked</div></div>${kinds}</div>
<h2>Complete sets checked against live Jupiter orderbooks</h2>
<table><tr><th>verdict</th><th>kind</th><th>event / legs</th><th>quoted</th><th>book</th><th>payout</th><th>size</th><th>fees</th><th>net</th><th>ROI</th><th>APR</th></tr>${rows}</table>
<h2>Traps rejected: ${s.traps ?? 0} baskets that look like arbitrage but are not complete sets</h2>
<p class="id">Checked against Polymarket negRisk / negRiskAugmented and Kalshi mutually_exclusive. A naive "sum of prices &lt; $1" scanner would buy these.</p>
<table><tr><th>kind</th><th>event</th><th>reason</th><th>quoted</th><th>payout</th></tr>${scan.traps.map((v) => `<tr class="NOT-A-COMPLETE-SET"><td><span class="tag">${v.candidate.kind}</span></td><td><div class="ev">${esc(v.candidate.eventTitle)}</div><div class="id">${esc(v.candidate.eventId)} · ${v.candidate.legs.length} legs</div></td><td style="text-align:left" class="id">${esc(v.exclusivity.note)}</td><td>${usd(v.candidate.quotedCost, 3)}</td><td>${usd(v.candidate.payout, 0)}</td></tr>`).join('')}</table>
${integ}
<p class="id">Fees: ceil_to_cent(0.07 · contracts · p · (1−p)) per leg, which reproduces Jupiter's published fee table exactly. APR assumes capital is locked until the market's close time. Not financial advice.</p></body></html>`;
}

export function toConsole({ scan, integrity }: Report): string {
  const s = scan.stats;
  const out: string[] = [];
  out.push(`pm-edge scan @ ${scan.generatedAt} (${shanghai(scan.generatedAt)})`);
  out.push(`  ${s.events} events · ${s.openMarkets}/${s.markets} open markets · ${Object.entries(s.candidates).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  out.push(`  median quoted overround: ${Object.entries(s.medianOverroundPct).map(([k, v]) => `${k} ${v}%`).join(' · ')}`);
  out.push(`  ${s.screened} baskets within screen · ${s.sourceChecked} structure-checked → ${s.traps} traps rejected, ${s.unverified} unverified · ${s.bookChecked} genuine sets checked on live books → ${scan.verified.filter((v) => v.verdict === 'ARB').length} ARB`);
  for (const v of scan.verified.slice(0, 12)) {
    const k = v.candidate;
    out.push(`  [${v.verdict.padEnd(18)}] ${k.kind.padEnd(17)} quoted ${k.quotedCost.toFixed(3)} book ${v.bookCost?.toFixed(3) ?? '  —  '} / ${k.payout}  net ${usd(v.sized?.netProfit)} on ${v.sized?.contracts.toFixed(0) ?? '—'} sets  ${k.eventTitle.slice(0, 50)}${k.kind === 'binary-yes-no' ? ' · ' + k.legs[0]!.title.slice(0, 25) : ''}`);
  }
  out.push(`  traps: ${s.naiveFalsePositives} would be false "free money" for a naive sum-of-prices scanner · ${Object.entries(s.trapReasons ?? {}).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  for (const v of scan.traps.slice(0, 5)) out.push(`  [TRAP] ${v.candidate.kind.padEnd(17)} quoted ${v.candidate.quotedCost.toFixed(3)} / ${v.candidate.payout}  ${v.candidate.eventTitle.slice(0, 50)} — ${v.exclusivity.note.slice(-90)}`);
  if (integrity) {
    out.push('  price integrity (Jupiter minus venue, cents):');
    for (const r of integrity.summary) out.push(`    ${r.provider.padEnd(10)} n=${r.n} median buy ${c(r.medianBuyDiffCents)} · median sell ${c(r.medianSellDiffCents)} · within ±1¢ ${r.withinOneCentPct}%`);
  }
  return out.join('\n');
}
