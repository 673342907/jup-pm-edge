import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tradingFee } from '../src/fees.ts';

// Every row of the fee table published at developers.jup.ag/docs/prediction (Fees section).
const PUBLISHED: [price: number, one: number, hundred: number][] = [
  [0.01, 0.01, 0.07], [0.05, 0.01, 0.34], [0.1, 0.01, 0.63], [0.15, 0.01, 0.9], [0.2, 0.02, 1.12],
  [0.25, 0.02, 1.32], [0.3, 0.02, 1.47], [0.35, 0.02, 1.6], [0.4, 0.02, 1.68],
];

test('fee model reproduces all 18 values in Jupiter\'s published fee table', () => {
  for (const [p, one, hundred] of PUBLISHED) {
    assert.equal(tradingFee(1, p), one, `1 contract @ ${p}`);
    assert.equal(tradingFee(100, p), hundred, `100 contracts @ ${p}`);
  }
});

test('documented worked example: 100 contracts at $0.25 costs $1.32 in fees', () => {
  assert.equal(tradingFee(100, 0.25), 1.32);
});

test('fee is symmetric around $0.50, zero for zero size, and never negative', () => {
  assert.equal(tradingFee(100, 0.3), tradingFee(100, 0.7));
  assert.equal(tradingFee(0, 0.5), 0);
  assert.ok(tradingFee(1, 0.999) >= 0);
});
