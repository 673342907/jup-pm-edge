/**
 * Price integrity: does trading through Jupiter on Solana cost more than going to the native venue?
 * Compares Jupiter's quoted buy/sell YES price with the live best ask/bid at Polymarket's CLOB or Kalshi.
 */
import { mapLimit } from './http.ts';
import type { IntegrityRow, JupEvent, JupMarket } from './types.ts';
import { Kalshi, Polymarket, type Quote } from './venues.ts';

const cents = (x: number) => Math.round(x * 10_000) / 100;

/** Pick the most-traded open markets per provider so the sample reflects where users actually trade. */
export function sampleMarkets(events: JupEvent[], perProvider: number): JupMarket[] {
  const byProv = new Map<string, JupMarket[]>();
  for (const e of events) for (const m of e.markets) {
    if (m.status !== 'open' || m.buyYes == null) continue;
    if (m.provider !== 'polymarket' && m.provider !== 'kalshi') continue;
    byProv.set(m.provider, [...(byProv.get(m.provider) ?? []), m]);
  }
  return [...byProv.values()].flatMap((ms) => ms.sort((a, b) => b.volume - a.volume).slice(0, perProvider));
}

/** Which CLOB token corresponds to "YES" in this Jupiter market. */
export function polyYesToken(m: JupMarket): string | null {
  if (!m.clobTokenIds?.length) return null;
  if (m.outcomes && m.yesLabels.length === 1) {
    const i = m.outcomes.indexOf(m.yesLabels[0]!);
    if (i >= 0) return m.clobTokenIds[i] ?? null;
  }
  return m.clobTokenIds[0] ?? null;
}

export function compare(m: JupMarket, q: Quote): IntegrityRow {
  return {
    marketId: m.marketId,
    provider: m.provider,
    title: m.title,
    jupBuyYes: m.buyYes,
    jupSellYes: m.sellYes,
    venueAsk: q.ask,
    venueBid: q.bid,
    buyDiffCents: m.buyYes != null && q.ask != null ? cents(m.buyYes - q.ask) : null,
    sellDiffCents: m.sellYes != null && q.bid != null ? cents(q.bid - m.sellYes) : null,
  };
}

export async function runIntegrity(markets: JupMarket[], poly = new Polymarket(), kalshi = new Kalshi(), concurrency = 6): Promise<IntegrityRow[]> {
  return mapLimit(markets, concurrency, async (m) => {
    try {
      let q: Quote;
      if (m.provider === 'polymarket') {
        const t = polyYesToken(m);
        if (!t) throw new Error('no CLOB token id');
        q = await poly.quote(t);
      } else {
        q = await kalshi.quote(m.marketId);
      }
      return compare(m, q);
    } catch (e) {
      return { ...compare(m, { bid: null, ask: null }), error: (e as Error).message.slice(0, 160) };
    }
  });
}

export interface IntegritySummary {
  provider: string;
  n: number;
  medianBuyDiffCents: number | null;
  meanBuyDiffCents: number | null;
  worstBuyDiffCents: number | null;
  medianSellDiffCents: number | null;
  withinOneCentPct: number | null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export function summarise(rows: IntegrityRow[]): IntegritySummary[] {
  const provs = [...new Set(rows.map((r) => r.provider))];
  return provs.map((p) => {
    const rs = rows.filter((r) => r.provider === p && r.buyDiffCents != null);
    const buy = rs.map((r) => r.buyDiffCents!);
    const sell = rows.filter((r) => r.provider === p && r.sellDiffCents != null).map((r) => r.sellDiffCents!);
    return {
      provider: p,
      n: rs.length,
      medianBuyDiffCents: median(buy),
      meanBuyDiffCents: buy.length ? Math.round((buy.reduce((a, b) => a + b, 0) / buy.length) * 100) / 100 : null,
      worstBuyDiffCents: buy.length ? Math.max(...buy) : null,
      medianSellDiffCents: median(sell),
      withinOneCentPct: buy.length ? Math.round((buy.filter((d) => Math.abs(d) <= 1).length / buy.length) * 1000) / 10 : null,
    };
  });
}
