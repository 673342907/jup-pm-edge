import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { HttpError } from '../src/http.ts';
import { JupiterPrediction } from '../src/jupiter.ts';
import type { Report } from '../src/report.ts';
import { scan } from '../src/scan.ts';
import { createDashboardServer } from '../src/server.ts';
import { Kalshi, Polymarket } from '../src/venues.ts';
import { fakeV0Tx, fixture, OTHER, OWNER, routeFetcher } from './helpers.ts';

/** Same planted world as scan.test.ts: Fed-decision YES legs sum to $0.90 (ARB); AFC Group F is a trap. */
function world(extra: Record<string, unknown> = {}) {
  const fed = fixture('jup-event-fed-december.json');
  const prices = [0.6, 0.1, 0.1, 0.05, 0.05];
  fed.markets.forEach((m: any, i: number) => (m.pricing.buyYesPriceUsd = prices[i]! * 1e6));
  const books: Record<string, unknown> = {};
  fed.markets.forEach((m: any, i: number) => (books[`/orderbook/${m.marketId}`] = { yes_dollars: [], no_dollars: [[(1 - prices[i]!).toFixed(4), 2000]] }));
  return routeFetcher({
    ...extra,
    'start=0&end=100&includeMarkets=true&provider=polymarket': { data: [fed, fixture('jup-event-afc-group-f.json')], pagination: { hasNext: false } },
    '/events?': { data: [], pagination: { hasNext: false } },
    ...books,
    '/orderbook/': { yes_dollars: [], no_dollars: [['0.9000', 500]] }, // every other leg (e.g. AFC trap) has a 10¢ ask
    'gamma-api.polymarket.com/events/770450': fixture('gamma-event-fed-december.json'),
    'gamma-api.polymarket.com/events/994372': fixture('gamma-event-afc-group-f.json'),
  });
}

let report: Report;
let base = '';
let calls: string[] = [];
let close: () => void;
const orderBodies: any[] = [];

before(async () => {
  const w = world();
  const res = await scan({ budgetUsd: 500 }, new JupiterPrediction(w.fetcher), new Polymarket(w.fetcher), new Kalshi(w.fetcher));
  const { events, ...scanResult } = res;
  report = { scan: scanResult, integrity: { rows: [], summary: [] } };
  const live = world({
    'prediction/v1/orders': (_u: string, o: any) => {
      orderBodies.push(o.body);
      if (o.body.ownerPubkey === OTHER) throw new HttpError(400, 'x', JSON.stringify({ type: 'invalid_request_error', code: 'unsupported_region', message: 'Trading is not available in your region' }));
      return { transaction: fakeV0Tx(o.body.ownerPubkey), txMeta: { blockhash: 'x', lastValidBlockHeight: 1 }, execution: { context: { type: 'create_order', id: o.body.marketId } }, order: { orderPubkey: 'o', positionPubkey: 'p' } };
    },
    'prediction/v1/execute': (_u: string, o: any) => ({ status: 'ok', echoed: o.body.context }),
    'rpc.test': (_u: string, o: any) => ({ jsonrpc: '2.0', id: 1, result: { value: { err: o.body.method === 'simulateTransaction' ? { InstructionError: [0, 'InsufficientFunds'] } : null, logs: ['Program log: sim'], unitsConsumed: 1234 } } }),
  });
  calls = live.calls;
  let scans = 0;
  const server = createDashboardServer({
    report,
    jup: new JupiterPrediction(live.fetcher),
    fetcher: live.fetcher,
    rpcUrl: 'https://rpc.test',
    runScan: async () => {
      scans++;
      await new Promise((r) => setTimeout(r, 150));
      return { ...report, scan: { ...report.scan, generatedAt: `rescan-${scans}` } };
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const get = (p: string) => fetch(base + p);
const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const arbId = () => report.scan.verified.find((v) => v.verdict === 'ARB')!.candidate.id;
const trapId = () => report.scan.traps.find((t) => t.candidate.eventId === 'POLY-994372')!.candidate.id;

test('serves the dashboard with security headers, and the stripped browser modules', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await r.text(), /pm-edge/);
  for (const p of ['/app.js', '/wallet.js', '/app.css']) assert.equal((await get(p)).status, 200, p);
  const js = await (await get('/lib/pricing.js')).text();
  assert.match(js, /export function quoteStake/);
  assert.doesNotMatch(js, /: number\)|interface StakeQuote/, 'TypeScript syntax must be stripped');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
  assert.equal(mod.tradingFee(100, 0.25), 1.32, 'the served module is executable JS with identical pricing');
});

test('no path traversal or arbitrary file serving', async () => {
  for (const p of ['/../package.json', '/src/server.ts', '/web/../src/safety.ts', '/%2e%2e/package.json']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('GET /api/scan/latest returns the loaded report; unknown API routes 404', async () => {
  const j = await (await get('/api/scan/latest')).json();
  assert.equal(j.source, 'file');
  assert.ok(j.report.scan.verified.length > 0);
  assert.equal((await get('/api/nope')).status, 404);
});

test('GET /api/basket/:id/quote prices a stake on live books', async () => {
  const r = await get(`/api/basket/${encodeURIComponent(arbId())}/quote?stake=100`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.source, 'live');
  assert.ok(j.quote.totalCost <= 100 && j.quote.netProfit > 0);
  assert.equal(j.asks.length, 5);
  assert.equal((await get(`/api/basket/${encodeURIComponent(arbId())}/quote?stake=99999`)).status, 400);
  assert.equal((await get('/api/basket/does-not-exist/quote?stake=10')).status, 404);
});

test('POST /api/orders/build: genuine ARB → real unsigned txs from Jupiter, fee payer checked', async () => {
  orderBodies.length = 0;
  const r = await post('/api/orders/build', { basketId: arbId(), ownerPubkey: OWNER, stakeUsd: 200, mode: 'dry-run' });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.built, true);
  assert.equal(j.review.canBuildUnsigned, true);
  assert.equal(j.review.canSign, false, 'dry-run never signs');
  assert.equal(j.legs.length, 5);
  for (const l of j.legs) {
    assert.equal(l.txCheck.status, 'pass');
    assert.equal(l.request.isBuy, true);
    assert.equal('contracts' in l.request, false, 'buys are sized by depositAmount per the API contract');
    assert.ok(Number(l.request.depositAmount) >= 5_000_000);
  }
  assert.equal(orderBodies.length, 5);
  const total = j.legs.reduce((s: number, l: any) => s + Number(l.request.depositAmount), 0) / 1e6;
  assert.ok(total <= 200 + 1e-6, `deposits ${total} must fit the stake`);
});

test('POST /api/orders/build: TRAP is hard-blocked in live mode, and Jupiter is never called', async () => {
  const before = calls.filter((c) => c.includes('/v1/orders')).length;
  const r = await post('/api/orders/build', { basketId: trapId(), ownerPubkey: OWNER, stakeUsd: 100, mode: 'live', acknowledgeTrap: true, acknowledgeLoss: true });
  assert.equal(r.status, 403);
  const j = await r.json();
  assert.match(j.review.blockers.join(' '), /TRAP/);
  assert.equal(calls.filter((c) => c.includes('/v1/orders')).length, before);
});

test('POST /api/orders/build: TRAP in dry-run needs acknowledgement and only ever returns a payload preview', async () => {
  const before = calls.filter((c) => c.includes('/v1/orders')).length;
  const blocked = await post('/api/orders/build', { basketId: trapId(), ownerPubkey: OWNER, stakeUsd: 100, mode: 'dry-run' });
  assert.equal(blocked.status, 403);
  const r = await post('/api/orders/build', { basketId: trapId(), ownerPubkey: OWNER, stakeUsd: 100, mode: 'dry-run', acknowledgeTrap: true });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.previewOnly, true);
  assert.equal(j.built, false);
  assert.deepEqual([j.review.canBuildUnsigned, j.review.canSign], [false, false]);
  assert.ok(j.legs.length >= 2 && j.legs.every((l: any) => l.request.isBuy && !l.transaction), 'request bodies only, no transactions');
  assert.equal(calls.filter((c) => c.includes('/v1/orders')).length, before, 'Jupiter POST /orders is never called for a trap');
});

test('POST /api/orders/build: the server ignores client claims about a basket (verdict comes from its own scan)', async () => {
  const r = await post('/api/orders/build', { basketId: trapId(), verdict: 'ARB', exclusivityStatus: 'verified', ownerPubkey: OWNER, stakeUsd: 100, mode: 'live' });
  assert.equal(r.status, 403);
});

test('POST /api/orders/build: invalid wallet and geo-blocked Jupiter responses are surfaced, not hidden', async () => {
  const bad = await post('/api/orders/build', { basketId: arbId(), ownerPubkey: 'not-a-key', stakeUsd: 100, mode: 'dry-run' });
  assert.equal(bad.status, 403);
  const geo = await (await post('/api/orders/build', { basketId: arbId(), ownerPubkey: OTHER, stakeUsd: 100, mode: 'dry-run' })).json();
  assert.equal(geo.built, false);
  assert.equal(geo.legs[0].error.code, 'unsupported_region');
  assert.ok(geo.legs[0].request.marketId, 'request body still returned for inspection');
});

test('POST /api/simulate proxies simulateTransaction with sigVerify off', async () => {
  const j = await (await post('/api/simulate', { transaction: fakeV0Tx(OWNER) })).json();
  assert.equal(j.ok, false);
  assert.deepEqual(j.err, { InstructionError: [0, 'InsufficientFunds'] });
  assert.equal(j.unitsConsumed, 1234);
  assert.equal((await post('/api/simulate', { transaction: 'not base64 !!' })).status, 400);
});

test('POST /api/orders/execute relays an already-signed tx with its context; validates input', async () => {
  const j = await (await post('/api/orders/execute', { signedTransaction: fakeV0Tx(OWNER), context: { type: 'create_order', id: 'm' } })).json();
  assert.deepEqual(j, { status: 'ok', echoed: { type: 'create_order', id: 'm' } });
  assert.equal((await post('/api/orders/execute', { signedTransaction: '<script>' })).status, 400);
  const big = await fetch(base + '/api/orders/execute', { method: 'POST', body: 'x'.repeat(70_000) });
  assert.equal(big.status, 400);
});

test('POST /api/scan runs in the background, rejects concurrent scans, then swaps in the new report', async () => {
  const r1 = await post('/api/scan', { maxEvents: 100 });
  assert.equal(r1.status, 202);
  assert.equal((await post('/api/scan', {})).status, 409);
  for (let i = 0; i < 50; i++) {
    const s = await (await get('/api/scan/status')).json();
    if (!s.scanning) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const j = await (await get('/api/scan/latest')).json();
  assert.equal(j.source, 'live-scan');
  assert.match(j.report.scan.generatedAt, /^rescan-/);
});
