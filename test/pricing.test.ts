import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askLadder, parseJupOrderbook, quoteStake, tradingFee } from '../src/pricing.ts';
import { fixture } from './helpers.ts';

const two = [
  [{ price: 0.45, qty: 100 }, { price: 0.5, qty: 100 }],
  [{ price: 0.45, qty: 100 }, { price: 0.6, qty: 100 }],
];

test('quoteStake: total spend (cost + Jupiter fees) never exceeds the stake', () => {
  for (const stake of [25, 50, 100, 250, 500]) {
    const q = quoteStake(two, 1, stake)!;
    assert.ok(q.totalCost <= stake + 1e-9, `stake ${stake}: total ${q.totalCost}`);
    assert.ok(Math.abs(q.totalCost - (q.grossCost + q.fees)) < 1e-6);
    q.legs.forEach((l) => assert.equal(l.fee, tradingFee(q.contracts, l.avgPrice)));
  }
});

test('quoteStake: bigger stakes walk deeper and pay slippage; net turns negative past the edge', () => {
  const small = quoteStake(two, 1, 50)!;
  const big = quoteStake(two, 1, 180)!;
  assert.equal(small.legs[0]!.slippageCents, 0);
  assert.ok(small.netProfit > 0);
  assert.ok(big.contracts > 100 && big.legs[1]!.slippageCents > 0);
  assert.ok(big.netProfit < small.netProfit * (big.contracts / small.contracts), 'marginal sets cost more');
});

test('quoteStake: flags depth-limited sizes and sub-$5 legs', () => {
  const thin = [[{ price: 0.5, qty: 10 }], [{ price: 0.4, qty: 10 }]];
  const q = quoteStake(thin, 1, 500)!;
  assert.equal(q.depthLimited, true);
  assert.equal(q.contracts, 10);
  const cheap = [[{ price: 0.02, qty: 1e6 }], [{ price: 0.9, qty: 1e6 }]];
  const c = quoteStake(cheap, 1, 50)!;
  assert.deepEqual(c.belowMinimum, [0]); // the $0.02 leg only gets ~$1 of a $50 stake
});

test('quoteStake: null on empty book or non-positive stake; APR from close time', () => {
  assert.equal(quoteStake([[{ price: 0.5, qty: 1 }], []], 1, 100), null);
  assert.equal(quoteStake(two, 1, 0), null);
  const now = 1_800_000_000;
  const q = quoteStake(two, 1, 50, { closeTime: now + 36.5 * 86_400, nowSec: now })!;
  assert.ok(Math.abs(q.apr! - q.roi * 10) < 1e-9);
});

test('quoteStake on a real Jupiter book (Polymarket-routed) produces a sane fill', () => {
  const book = parseJupOrderbook(fixture('jup-orderbook-poly.json'));
  const yes = askLadder(book, 'yes');
  const q = quoteStake([yes], 1, 100)!;
  assert.ok(q.contracts > 0 && q.legs[0]!.avgPrice >= q.legs[0]!.bestAsk);
});
