import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCandidates } from '../src/completeSet.ts';
import { toEvent } from '../src/jupiter.ts';
import { checkExclusivity } from '../src/scan.ts';
import { Kalshi, Polymarket } from '../src/venues.ts';
import { fixture, routeFetcher } from './helpers.ts';

const { fetcher } = routeFetcher({
  'gamma-api.polymarket.com/events/994372': fixture('gamma-event-afc-group-f.json'),
  'gamma-api.polymarket.com/events/770450': fixture('gamma-event-fed-december.json'),
  'kalshi.com/trade-api/v2/events/KXVENEZUELALEADER-26DEC31': fixture('kalshi-event-venezuela.json'),
});
const poly = new Polymarket(fetcher);
const kalshi = new Kalshi(fetcher);

test('TRAP: AFC Asian Cup group winner (negRiskAugmented placeholders) is not a YES complete set', async () => {
  const ev = toEvent(fixture('jup-event-afc-group-f.json'));
  const yes = buildCandidates([ev]).find((c) => c.kind === 'multi-outcome-yes')!;
  assert.ok(yes.quotedCost < 0.5, 'quotes alone make this look like >50% free money');
  const r = await checkExclusivity(yes, ev, poly, kalshi);
  assert.equal(r.status, 'rejected');
  assert.match(r.note, /negRiskAugmented=true/);
});

test('Fed decision (negRisk, no placeholders, all 5 listed) is a verified YES complete set', async () => {
  const ev = toEvent(fixture('jup-event-fed-december.json'));
  const yes = buildCandidates([ev]).find((c) => c.kind === 'multi-outcome-yes')!;
  const r = await checkExclusivity(yes, ev, poly, kalshi);
  assert.equal(r.status, 'verified', r.note);
});

test('dropping one outcome from a YES basket is rejected (Jupiter missing an outcome)', async () => {
  const ev = toEvent(fixture('jup-event-fed-december.json'));
  const yes = buildCandidates([ev]).find((c) => c.kind === 'multi-outcome-yes')!;
  const partial = { ...yes, legs: yes.legs.slice(1) };
  const r = await checkExclusivity(partial, ev, poly, kalshi);
  assert.equal(r.status, 'rejected');
  assert.match(r.note, /missing 1/);
});

test('NO baskets only need mutual exclusivity, so augmented events still qualify', async () => {
  const raw = fixture('jup-event-afc-group-f.json');
  const ev = toEvent(raw);
  const no = { ...buildCandidates([ev]).find((c) => c.kind === 'multi-outcome-yes')!, kind: 'multi-outcome-no' as const, payout: 3 };
  const r = await checkExclusivity(no, ev, poly, kalshi);
  assert.equal(r.status, 'verified', r.note);
});

test('Kalshi: non-exclusive events are rejected; Kalshi never claims exhaustiveness', async () => {
  const ev = toEvent(fixture('jup-event-kalshi-venezuela.json'));
  const yes = buildCandidates([ev]).find((c) => c.kind === 'multi-outcome-yes');
  if (yes) {
    const r = await checkExclusivity(yes, ev, poly, kalshi);
    assert.equal(r.status, 'rejected'); // mutually_exclusive=false in the live fixture
  }
  const fake = { ...fixture('kalshi-event-venezuela.json') };
  fake.event = { ...fake.event, mutually_exclusive: true };
  const k2 = new Kalshi(routeFetcher({ 'events/KXVENEZUELALEADER-26DEC31': fake }).fetcher);
  const yes2 = buildCandidates([ev]).find((c) => c.kind === 'multi-outcome-yes');
  if (yes2) assert.equal((await checkExclusivity(yes2, ev, poly, k2)).status, 'unverified');
});

test('structural baskets need no network call', async () => {
  const { fetcher: f, calls } = routeFetcher({});
  const ev = toEvent(fixture('jup-event-fed-december.json'));
  const bin = buildCandidates([ev]).find((c) => c.kind === 'binary-yes-no')!;
  const r = await checkExclusivity(bin, ev, new Polymarket(f), new Kalshi(f));
  assert.equal(r.status, 'structural');
  assert.equal(calls.length, 0);
});

test('source lookup failures degrade to UNVERIFIED, never ARB', async () => {
  const { fetcher: f } = routeFetcher({});
  const ev = toEvent(fixture('jup-event-fed-december.json'));
  const yes = buildCandidates([ev]).find((c) => c.kind === 'multi-outcome-yes')!;
  const r = await checkExclusivity(yes, ev, new Polymarket(f), new Kalshi(f));
  assert.equal(r.status, 'unverified');
});
