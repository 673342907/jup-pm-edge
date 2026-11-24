import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildDemoHtml, scriptSafeJson, slimReport } from '../src/demo.ts';
import type { Report } from '../src/report.ts';

const report: Report = {
  scan: {
    generatedAt: '2026-11-24T00:00:00.000Z',
    stats: { events: 1, markets: 2, openMarkets: 2, candidates: {}, medianOverroundPct: {}, screened: 0 },
    verified: [],
    traps: [{ candidate: { id: 'x', kind: 'multi-outcome-yes', eventId: 'E', eventTitle: 'evil </script><script>alert(1)</script>', provider: 'polymarket', category: '', closeTime: null, legs: [], quotedCost: 0.1, payout: 1 }, exclusivity: { status: 'rejected', note: 'n' }, bookCost: null, sized: null, verdict: 'NOT-A-COMPLETE-SET' }],
    unverified: [],
    tightest: [],
  },
};

test('demo embeds data safely (no script breakout) and inlines every module via an import map', async () => {
  const html = buildDemoHtml(report);
  assert.equal(html.match(/<\/script>/g)!.length, html.match(/<script/g)!.length, 'every </script> belongs to a real script tag');
  assert.doesNotMatch(html, /alert\(1\)<\/script>/);
  assert.match(html, /window.__PM_EDGE_DEMO__/);
  const map = JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/s)![1]!);
  assert.deepEqual(Object.keys(map.imports).sort(), ['./lib/pricing.js', './lib/safety.js', './wallet.js']);
  const pricing = await import(map.imports['./lib/pricing.js']);
  const safety = await import(map.imports['./lib/safety.js']);
  assert.equal(pricing.tradingFee(100, 0.4), 1.68);
  assert.equal(safety.isValidPubkey('11111111111111111111111111111111'), true);
  assert.doesNotMatch(html, /src="\.\/app\.js"/, 'app is inlined');
});

test('scriptSafeJson round-trips and escapes HTML-significant characters', () => {
  const v = { a: '</script><!-- \u2028', b: [1, 2] };
  const s = scriptSafeJson(v);
  assert.doesNotMatch(s, /<|>|\u2028/);
  assert.deepEqual(JSON.parse(s), v);
});

test('slimReport keeps what the UI renders and drops trap books', () => {
  const s = slimReport(report);
  assert.equal(s.scan.traps.length, 1);
  assert.equal(s.scan.tightest.length, 0);
});

test('wrangler.toml ships the static demo only (no Worker code that would hit Jupiter from a geo-blocked edge)', () => {
  const t = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(t, /\[assets\]/);
  assert.match(t, /directory\s*=\s*"\.\/site"/);
  assert.doesNotMatch(t, /^main\s*=/m);
});
