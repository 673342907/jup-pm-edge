import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base58Decode, base58Encode, checkUnsignedTx, inspectTransaction, isValidPubkey, reviewExecution, type ReviewInput } from '../src/safety.ts';
import { fakeV0Tx, OTHER, OWNER } from './helpers.ts';

const goodQuote = { netProfit: 3.2, totalCost: 96, fees: 1.4, legs: [{ deposit: 48 }, { deposit: 48 }], depthLimited: false };
const base: ReviewInput = { mode: 'dry-run', ownerPubkey: OWNER, verdict: 'ARB', exclusivityStatus: 'verified', exclusivityNote: 'negRisk, all outcomes listed', stakeUsd: 100, quote: goodQuote };
const status = (r: ReturnType<typeof reviewExecution>, name: string) => r.checks.find((c) => c.name === name)?.status;

test('base58 round-trips and validates 32-byte public keys', () => {
  const bytes = base58Decode(OWNER)!;
  assert.equal(bytes.length, 32);
  assert.equal(base58Encode(bytes), OWNER);
  assert.equal(base58Encode(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.ok(isValidPubkey(OWNER));
  for (const bad of ['', 'abc', '0OIl' + OWNER.slice(4), OWNER + 'x', 42, null]) assert.equal(isValidPubkey(bad), false);
});

test('genuine ARB: dry-run can build (not sign); live can sign', () => {
  const d = reviewExecution(base);
  assert.deepEqual([d.canBuildUnsigned, d.previewOnly, d.canSign], [true, false, false]);
  const l = reviewExecution({ ...base, mode: 'live' });
  assert.deepEqual([l.canBuildUnsigned, l.canSign], [true, true]);
  assert.equal(l.blockers.length, 0);
  assert.ok(l.warnings.some((w) => /separate transaction/.test(w)), 'partial-fill risk is always disclosed');
});

test('TRAP baskets are hard-blocked in live mode, even with every acknowledgement', () => {
  const r = reviewExecution({ ...base, mode: 'live', verdict: 'NOT-A-COMPLETE-SET', exclusivityStatus: 'rejected', exclusivityNote: 'negRiskAugmented=true', acknowledgeTrap: true, acknowledgeLoss: true });
  assert.deepEqual([r.canBuildUnsigned, r.previewOnly, r.canSign], [false, false, false]);
  assert.equal(status(r, 'complete-set'), 'block');
});

test('TRAP in dry-run: blocked until explicitly inspected, then payload PREVIEW only', () => {
  const trap = { ...base, verdict: 'NOT-A-COMPLETE-SET', exclusivityStatus: 'rejected', exclusivityNote: 'not mutually exclusive' };
  const blocked = reviewExecution(trap);
  assert.deepEqual([blocked.canBuildUnsigned, blocked.previewOnly], [false, false]);
  const inspected = reviewExecution({ ...trap, acknowledgeTrap: true });
  assert.deepEqual([inspected.canBuildUnsigned, inspected.previewOnly, inspected.canSign], [false, true, false]);
  assert.match(inspected.checks.find((c) => c.name === 'edge')!.detail, /illusory.*worst case -\$96/, 'a trap never shows a "profit"');
});

test('a rejected exclusivity status blocks even if the verdict string looks harmless', () => {
  const r = reviewExecution({ ...base, mode: 'live', verdict: 'ARB', exclusivityStatus: 'rejected' });
  assert.equal(r.canSign, false);
});

test('UNVERIFIED: never signable; dry-run preview only', () => {
  const u = { ...base, verdict: 'UNVERIFIED', exclusivityStatus: 'unverified' };
  assert.equal(reviewExecution({ ...u, mode: 'live' }).canSign, false);
  const d = reviewExecution(u);
  assert.deepEqual([d.canBuildUnsigned, d.previewOnly], [false, true]);
});

test('blocks: invalid wallet, no depth, sub-$5 leg, over-cap stake, cost above stake', () => {
  assert.equal(status(reviewExecution({ ...base, ownerPubkey: 'nope' }), 'wallet'), 'block');
  assert.equal(status(reviewExecution({ ...base, quote: null }), 'depth'), 'block');
  assert.equal(status(reviewExecution({ ...base, quote: { ...goodQuote, legs: [{ deposit: 4.99 }, { deposit: 90 }] } }), 'min-order'), 'block');
  assert.equal(status(reviewExecution({ ...base, stakeUsd: 5000 }), 'stake'), 'block');
  assert.equal(status(reviewExecution({ ...base, quote: { ...goodQuote, totalCost: 101 } }), 'max-cost'), 'block');
});

test('negative edge: warning in dry-run, blocking in live until acknowledged', () => {
  const loss = { ...base, quote: { ...goodQuote, netProfit: -0.43 } };
  assert.equal(status(reviewExecution(loss), 'edge'), 'warn');
  assert.equal(reviewExecution({ ...loss, mode: 'live' }).canSign, false);
  assert.equal(reviewExecution({ ...loss, mode: 'live', acknowledgeLoss: true }).canSign, true);
});

test('inspectTransaction decodes v0 headers; checkUnsignedTx enforces the fee payer', () => {
  const tx = Buffer.from(fakeV0Tx(OWNER), 'base64');
  const t = inspectTransaction(tx);
  assert.deepEqual([t.version, t.signatures, t.feePayer, t.requiredSigners, t.accountKeys], [0, 1, OWNER, [OWNER], 3]);
  assert.equal(checkUnsignedTx(tx, OWNER).status, 'pass');
  assert.equal(checkUnsignedTx(tx, OTHER).status, 'block'); // someone else pays / signs
  const multi = Buffer.from(fakeV0Tx(OWNER, [OTHER]), 'base64');
  assert.equal(checkUnsignedTx(multi, OWNER).status, 'warn');
  assert.equal(checkUnsignedTx(new Uint8Array([1, 2, 3]), OWNER).status, 'block');
});
