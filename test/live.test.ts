/** Live smoke test against the real APIs. Run with: npm run test:live */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JupiterPrediction } from '../src/jupiter.ts';
import { scan } from '../src/scan.ts';

const live = process.env.PM_EDGE_LIVE === '1';

test('live: Jupiter Prediction API is reachable and trading-status responds', { skip: !live }, async () => {
  const jup = new JupiterPrediction();
  assert.equal(typeof (await jup.tradingActive()), 'boolean');
});

test('live: a 300-event scan completes and every ARB is structurally verified', { skip: !live, timeout: 180_000 }, async () => {
  const r = await scan({ maxEvents: 300, maxVerify: 20 });
  assert.ok(r.stats.events > 0);
  for (const v of r.verified) {
    if (v.verdict === 'ARB') assert.ok(['structural', 'verified'].includes(v.exclusivity.status));
  }
});
