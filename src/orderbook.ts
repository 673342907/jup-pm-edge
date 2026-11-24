import type { Level, JupOrderbook } from './types.ts';

/** Parse Jupiter's `[priceString, qty]` dollar ladders (falls back to integer-cent ladders). */
export function parseJupOrderbook(raw: unknown): JupOrderbook {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ladder = (dollars: unknown, cents: unknown): Level[] => {
    if (Array.isArray(dollars) && dollars.length) {
      return dollars.map((l) => ({ price: Number((l as unknown[])[0]), qty: Number((l as unknown[])[1]) }));
    }
    if (Array.isArray(cents)) {
      return cents.map((l) => ({ price: Number((l as unknown[])[0]) / 100, qty: Number((l as unknown[])[1]) }));
    }
    return [];
  };
  const clean = (ls: Level[]) => ls.filter((l) => Number.isFinite(l.price) && l.qty > 0 && l.price > 0 && l.price < 1);
  return {
    yesBids: clean(ladder(r.yes_dollars, r.yes)),
    noBids: clean(ladder(r.no_dollars, r.no)),
  };
}

/**
 * In a binary market a bid for NO at p is an offer to sell YES at 1 - p (and vice versa).
 * Returns the ask ladder for `side`, cheapest first.
 */
export function askLadder(book: JupOrderbook, side: 'yes' | 'no'): Level[] {
  const opposite = side === 'yes' ? book.noBids : book.yesBids;
  return opposite
    .map((l) => ({ price: round6(1 - l.price), qty: l.qty }))
    .sort((a, b) => a.price - b.price);
}

export function bestBid(levels: Level[]): number | null {
  return levels.length ? Math.max(...levels.map((l) => l.price)) : null;
}
export function bestAsk(levels: Level[]): number | null {
  return levels.length ? Math.min(...levels.map((l) => l.price)) : null;
}

/** Cost of buying `qty` contracts by walking an ask ladder; null if depth is insufficient. */
export function costToBuy(asks: Level[], qty: number): number | null {
  let left = qty;
  let cost = 0;
  for (const l of asks) {
    const take = Math.min(left, l.qty);
    cost += take * l.price;
    left -= take;
    if (left <= 1e-9) return cost;
  }
  return null;
}

export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
