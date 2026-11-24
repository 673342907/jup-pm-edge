import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCandidates, quotedEdge, sizeCompleteSet } from '../src/completeSet.ts';
import { toEvent } from '../src/jupiter.ts';
import { fixture } from './helpers.ts';

const page = fixture('jup-events-page.json').data.map(toEvent);

test('builds condition-pair baskets for Polymarket games Jupiter splits per team', () => {
  const pairs = buildCandidates(page).filter((c) => c.kind === 'condition-pair');
  assert.ok(pairs.length > 0);
  for (const p of pairs) {
    assert.equal(p.legs.length, 2);
    assert.equal(p.payout, 1);
    assert.ok(p.legs.every((l) => l.side === 'yes'));
  }
});

test('builds YES and NO baskets for a 5-outcome event (Fed decision)', () => {
  const fed = toEvent(fixture('jup-event-fed-december.json'));
  const c = buildCandidates([fed]);
  const yes = c.find((x) => x.kind === 'multi-outcome-yes')!;
  const no = c.find((x) => x.kind === 'multi-outcome-no')!;
  assert.equal(yes.legs.length, 5);
  assert.equal(no.payout, 4); // NO on all five pays at least $4
  assert.equal(c.filter((x) => x.kind === 'binary-yes-no').length, 5);
  assert.ok(Math.abs(quotedEdge(yes) - (1 - yes.quotedCost)) < 1e-9);
});

test('micro-USD prices are converted and 0 means "no quote"', () => {
  const fed = toEvent(fixture('jup-event-fed-december.json'));
  const m = fed.markets.find((x) => x.title === '25 bps increase')!;
  assert.equal(m.buyYes, 0.94);
  assert.equal(m.buyNo, 0.07);
  const game = page.find((e: any) => e.markets.some((m: any) => m.conditionId && m.buyNo == null));
  assert.ok(game, 'Polymarket team markets expose YES only');
});

const now = 1_795_000_000;
const inThirtyDays = now + 30 * 86_400;

test('sizing finds a genuine arbitrage and nets fees', () => {
  // Two legs whose best asks sum to 0.90: 10c gross edge per set.
  const asks = [
    [{ price: 0.45, qty: 100 }, { price: 0.5, qty: 100 }],
    [{ price: 0.45, qty: 100 }, { price: 0.6, qty: 100 }],
  ];
  const r = sizeCompleteSet(asks, 1, inThirtyDays, { nowSec: now, budgetUsd: 10_000 })!;
  assert.equal(r.contracts, 100); // the second level sums to >1, so it stops at 100
  assert.equal(r.grossCost, 90);
  assert.equal(r.fees, 2 * 1.74); // ceil(0.07*100*0.45*0.55) = 1.74 per leg
  assert.ok(Math.abs(r.netProfit - (100 - 90 - 3.48)) < 1e-9);
  assert.ok(r.apr! > r.roi);
});

test('fees can erase a thin quoted edge', () => {
  const asks = [[{ price: 0.495, qty: 1000 }], [{ price: 0.495, qty: 1000 }]]; // 1c gross edge
  const r = sizeCompleteSet(asks, 1, inThirtyDays, { nowSec: now })!;
  assert.ok(r.netProfit < 0, `expected loss after fees, got ${r.netProfit}`);
});

test('respects Jupiter\'s $5 minimum per leg and the budget cap', () => {
  const cheap = [[{ price: 0.02, qty: 100 }], [{ price: 0.9, qty: 100 }]];
  // 0.02 * 100 = $2 < $5 minimum on the cheap leg: infeasible at any size.
  assert.equal(sizeCompleteSet(cheap, 1, null, { nowSec: now }), null);
  const deep = [[{ price: 0.4, qty: 1e6 }], [{ price: 0.4, qty: 1e6 }]];
  const r = sizeCompleteSet(deep, 1, null, { nowSec: now, budgetUsd: 100 })!;
  assert.ok(r.grossCost + r.fees <= 100);
  assert.ok(r.contracts > 100);
  assert.equal(r.apr, null);
});

test('returns null when a leg has no asks', () => {
  assert.equal(sizeCompleteSet([[{ price: 0.4, qty: 10 }], []], 1, null), null);
});
