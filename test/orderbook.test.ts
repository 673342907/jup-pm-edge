import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askLadder, bestAsk, bestBid, costToBuy, parseJupOrderbook } from '../src/orderbook.ts';
import { fixture } from './helpers.ts';

test('parses a real Jupiter orderbook (Polymarket-sourced market)', () => {
  const ob = parseJupOrderbook(fixture('jup-orderbook-poly.json'));
  assert.ok(ob.yesBids.length > 0);
  for (const l of [...ob.yesBids, ...ob.noBids]) {
    assert.ok(l.price > 0 && l.price < 1);
    assert.ok(l.qty > 0);
  }
});

test('falls back to integer-cent ladders when dollar ladders are absent', () => {
  const ob = parseJupOrderbook({ yes: [[40, 10]], no: [[55, 5]] });
  assert.deepEqual(ob.yesBids, [{ price: 0.4, qty: 10 }]);
  assert.deepEqual(ob.noBids, [{ price: 0.55, qty: 5 }]);
});

test('NO bids become YES asks at 1 - p, cheapest first', () => {
  const ob = { yesBids: [{ price: 0.3, qty: 1 }], noBids: [{ price: 0.6, qty: 10 }, { price: 0.65, qty: 4 }] };
  assert.deepEqual(askLadder(ob, 'yes'), [{ price: 0.35, qty: 4 }, { price: 0.4, qty: 10 }]);
  assert.deepEqual(askLadder(ob, 'no'), [{ price: 0.7, qty: 1 }]);
  assert.equal(bestAsk(askLadder(ob, 'yes')), 0.35);
  assert.equal(bestBid(ob.noBids), 0.65);
});

test('costToBuy walks the ladder and returns null when depth runs out', () => {
  const asks = [{ price: 0.35, qty: 4 }, { price: 0.4, qty: 10 }];
  assert.equal(costToBuy(asks, 4), 1.4);
  assert.ok(Math.abs(costToBuy(asks, 6)! - (1.4 + 0.8)) < 1e-12);
  assert.equal(costToBuy(asks, 15), null);
});
