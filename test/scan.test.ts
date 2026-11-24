import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JupiterPrediction } from '../src/jupiter.ts';
import { toHtml, toMarkdown } from '../src/report.ts';
import { scan } from '../src/scan.ts';
import { Kalshi, Polymarket } from '../src/venues.ts';
import { fixture, routeFetcher } from './helpers.ts';

/**
 * End-to-end pipeline on recorded live data, with one planted mispricing so the expected answer is known:
 * the real Fed-decision event, but its five YES legs are made to sum to $0.90 on both the quotes and the book.
 */
function world() {
  const fed = fixture('jup-event-fed-december.json');
  const prices = [0.6, 0.1, 0.1, 0.05, 0.05];
  fed.markets.forEach((m: any, i: number) => {
    m.pricing.buyYesPriceUsd = prices[i]! * 1e6;
  });
  const afc = fixture('jup-event-afc-group-f.json');
  const books: Record<string, unknown> = {};
  fed.markets.forEach((m: any, i: number) => {
    // A NO bid at 1 - p is a YES ask at p. 2,000 contracts of depth per leg.
    books[`/orderbook/${m.marketId}`] = { yes_dollars: [], no_dollars: [[(1 - prices[i]!).toFixed(4), 2000]] };
  });
  return routeFetcher({
    'start=0&end=100&includeMarkets=true&provider=polymarket': { data: [fed, afc], pagination: { start: 0, end: 2, hasNext: false } },
    '/events?': { data: [], pagination: { hasNext: false } },
    ...books,
    '/orderbook/': { yes_dollars: [], no_dollars: [] },
    'gamma-api.polymarket.com/events/770450': fixture('gamma-event-fed-december.json'),
    'gamma-api.polymarket.com/events/994372': fixture('gamma-event-afc-group-f.json'),
  });
}

test('scan finds the planted arbitrage, sizes it on depth, and rejects the AFC trap', async () => {
  const { fetcher } = world();
  const res = await scan({ budgetUsd: 500, screen: 0.01 }, new JupiterPrediction(fetcher), new Polymarket(fetcher), new Kalshi(fetcher));
  const arb = res.verified.find((v) => v.verdict === 'ARB')!;
  assert.ok(arb, 'expected an ARB');
  assert.equal(res.stats.events, 2, 'kalshi pass must not duplicate polymarket events');
  assert.equal(arb.candidate.eventId, 'POLY-770450');
  assert.equal(arb.candidate.kind, 'multi-outcome-yes');
  assert.equal(arb.exclusivity.status, 'verified');
  assert.equal(arb.bookCost, 0.9);
  assert.ok(arb.sized!.grossCost + arb.sized!.fees <= 500);
  assert.ok(arb.sized!.netProfit > 0);
  // Leg minimum: the $0.05 legs need >= 100 contracts to reach $5.
  assert.ok(arb.sized!.contracts >= 100);
  // Order plan: one POST /orders body per leg, each >= $5 (5_000_000 micro-USDC), never more than the budget in total.
  assert.equal(arb.orders!.length, 5);
  assert.ok(arb.orders!.every((o) => o.isBuy && o.isYes && Number(o.depositAmount) >= 5_000_000));
  const total = arb.orders!.reduce((s, o) => s + Number(o.depositAmount), 0) / 1e6;
  assert.ok(Math.abs(total - (arb.sized!.grossCost + arb.sized!.fees)) < 0.01);

  const trap = res.traps.find((t) => t.candidate.eventId === 'POLY-994372' && t.candidate.kind === 'multi-outcome-yes');
  assert.ok(trap, 'AFC augmented basket must be reported as a trap');
  assert.equal(res.verified.filter((v) => v.candidate.eventId === 'POLY-994372' && v.candidate.kind === 'multi-outcome-yes').length, 0);

  const md = toMarkdown({ scan: res });
  assert.match(md, /Traps rejected/);
  assert.match(toHtml({ scan: res }), /<table>/);
});

test('diverseTraps round-robins across rejection reasons', async () => {
  const { diverseTraps } = await import('../src/scan.ts');
  const mk = (note: string, i: number) => ({ candidate: { eventId: String(i) } as any, exclusivity: { status: 'rejected' as const, note }, bookCost: null, sized: null, verdict: 'NOT-A-COMPLETE-SET' as const });
  const traps = [...Array.from({ length: 10 }, (_, i) => mk('outcomes are not mutually exclusive', i)), mk('negRiskAugmented=true; NOT exhaustive', 99)];
  const out = diverseTraps(traps, 3);
  assert.equal(out.length, 3);
  assert.ok(out.some((t) => t.candidate.eventId === '99'));
});
