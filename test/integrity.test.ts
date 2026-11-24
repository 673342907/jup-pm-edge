import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, polyYesToken, runIntegrity, sampleMarkets, summarise } from '../src/integrity.ts';
import { toEvent } from '../src/jupiter.ts';
import { Kalshi, Polymarket } from '../src/venues.ts';
import { fixture, routeFetcher } from './helpers.ts';

const page = fixture('jup-events-page.json').data.map(toEvent);
const venezuela = toEvent(fixture('jup-event-kalshi-venezuela.json'));

test('maps a Jupiter per-team market to the right Polymarket CLOB token', () => {
  const game = page.find((e: any) => e.eventId === 'POLY-1307694')!;
  const [a, b] = game.markets;
  assert.notEqual(polyYesToken(a!), polyYesToken(b!));
  assert.equal(polyYesToken(a!), a!.clobTokenIds![a!.outcomes!.indexOf(a!.yesLabels[0]!)]);
});

test('compare() reports cents; positive means Jupiter is dearer', () => {
  const m = { ...page[1]!.markets[0]!, buyYes: 0.52, sellYes: 0.49 };
  const r = compare(m, { ask: 0.51, bid: 0.5 });
  assert.equal(r.buyDiffCents, 1);
  assert.equal(r.sellDiffCents, 1);
});

test('Kalshi quote derives YES ask from the best NO bid (real orderbook fixture)', async () => {
  const k = new Kalshi(routeFetcher({ '/orderbook': fixture('kalshi-orderbook-nmad.json') }).fetcher);
  const q = await k.quote('KXVENEZUELALEADER-26DEC31-NMAD');
  assert.ok(q.ask != null && q.bid != null);
  assert.ok(q.ask! > q.bid!, `ask ${q.ask} should exceed bid ${q.bid}`);
});

test('runIntegrity samples top-volume markets per provider and isolates per-market failures', async () => {
  const sample = sampleMarkets([...page, venezuela], 3);
  assert.ok(sample.some((m) => m.provider === 'kalshi'));
  assert.ok(sample.some((m) => m.provider === 'polymarket'));
  const { fetcher } = routeFetcher({
    'clob.polymarket.com/book': { bids: [{ price: '0.48', size: '100' }], asks: [{ price: '0.50', size: '100' }] },
  }); // no Kalshi route -> those rows error but the run continues
  const rows = await runIntegrity(sample, new Polymarket(fetcher), new Kalshi(fetcher));
  assert.equal(rows.length, sample.length);
  assert.ok(rows.filter((r) => r.provider === 'kalshi').every((r) => r.error));
  const s = summarise(rows);
  assert.equal(s.find((x) => x.provider === 'polymarket')!.n, sample.filter((m) => m.provider === 'polymarket').length);
});
