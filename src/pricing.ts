/**
 * Browser-safe pricing core. NO imports, so the dashboard can load this exact file (types stripped at serve
 * time) and CLI, server and browser all price baskets with identical code.
 */

export interface Level {
  price: number;
  qty: number;
}
export interface Book {
  yesBids: Level[];
  noBids: Level[];
}

export const FEE_RATE = 0.07;
export const MIN_ORDER_USD = 5;
export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

/**
 * Jupiter Prediction trading fee: ceil_to_cent(0.07 * contracts * p * (1 - p)). Reproduces every row of the
 * published fee table (developers.jup.ag/docs/prediction -> Fees); pinned by test/fees.test.ts.
 */
export function tradingFee(contracts: number, price: number, rate = FEE_RATE): number {
  if (contracts <= 0) return 0;
  const raw = rate * contracts * price * (1 - price);
  return Math.ceil(Number((raw * 100).toFixed(9))) / 100;
}

/** Parse Jupiter's orderbook response (`yes_dollars` / `no_dollars`, falling back to integer-cent ladders). */
export function parseJupOrderbook(raw: unknown): Book {
  const r = (raw ?? {}) as Record<string, unknown>;
  const ladder = (dollars: unknown, cents: unknown): Level[] => {
    if (Array.isArray(dollars) && dollars.length) return dollars.map((l) => ({ price: Number((l as unknown[])[0]), qty: Number((l as unknown[])[1]) }));
    if (Array.isArray(cents)) return cents.map((l) => ({ price: Number((l as unknown[])[0]) / 100, qty: Number((l as unknown[])[1]) }));
    return [];
  };
  const clean = (ls: Level[]) => ls.filter((l) => Number.isFinite(l.price) && l.qty > 0 && l.price > 0 && l.price < 1);
  return { yesBids: clean(ladder(r.yes_dollars, r.yes)), noBids: clean(ladder(r.no_dollars, r.no)) };
}

/** A NO bid at p is an offer to sell YES at 1 - p (and vice versa). Ask ladder for `side`, cheapest first. */
export function askLadder(book: Book, side: 'yes' | 'no'): Level[] {
  const opposite = side === 'yes' ? book.noBids : book.yesBids;
  return opposite.map((l) => ({ price: round6(1 - l.price), qty: l.qty })).sort((a, b) => a.price - b.price);
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
  return left <= 1e-9 ? cost : null;
}

export interface StakeLeg {
  bestAsk: number;
  avgPrice: number;
  cost: number;
  fee: number;
  /** cost + fee in USD; Jupiter's `depositAmount` for this leg (fees are charged in the deposit mint). */
  deposit: number;
  /** avg fill minus best ask, in cents: what depth costs you. */
  slippageCents: number;
}

export interface StakeQuote {
  stakeUsd: number;
  contracts: number;
  legs: StakeLeg[];
  grossCost: number;
  fees: number;
  totalCost: number;
  payoutUsd: number;
  netProfit: number;
  roi: number;
  apr: number | null;
  /** true when book depth, not the stake, capped the size. */
  depthLimited: boolean;
  /** Indexes of legs whose deposit is below Jupiter's $5 minimum order. */
  belowMinimum: number[];
}

/**
 * How many complete sets does `stakeUsd` buy right now, and what does it net? Binary-searches the largest
 * size whose total (all legs' depth-walked cost + Jupiter fees) fits the stake. Null if any leg has no asks.
 */
export function quoteStake(asks: Level[][], payout: number, stakeUsd: number, opts: { closeTime?: number | null; nowSec?: number; minOrderUsd?: number } = {}): StakeQuote | null {
  const { closeTime = null, nowSec = Date.now() / 1000, minOrderUsd = MIN_ORDER_USD } = opts;
  if (!asks.length || asks.some((a) => !a.length) || !(stakeUsd > 0)) return null;
  const depth = Math.min(...asks.map((a) => a.reduce((s, l) => s + l.qty, 0)));
  const total = (q: number) => {
    let t = 0;
    for (const a of asks) {
      const c = costToBuy(a, q);
      if (c == null) return Infinity;
      t += Math.ceil((c + tradingFee(q, c / q)) * 1e6 - 1e-6) / 1e6; // what the per-leg depositAmount will be
    }
    return t;
  };
  let lo = 0;
  let hi = depth;
  if (total(hi) <= stakeUsd) lo = hi;
  else for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) <= stakeUsd) lo = mid;
    else hi = mid;
  }
  const q = Math.floor(lo * 1e6) / 1e6;
  if (q <= 0) return null;
  const legs: StakeLeg[] = asks.map((a) => {
    const cost = costToBuy(a, q)!;
    const avgPrice = cost / q;
    const fee = tradingFee(q, avgPrice);
    return { bestAsk: a[0]!.price, avgPrice: round6(avgPrice), cost: round6(cost), fee, deposit: Math.ceil((cost + fee) * 1e6 - 1e-6) / 1e6, slippageCents: round6((avgPrice - a[0]!.price) * 100) };
  });
  const grossCost = round6(legs.reduce((s, l) => s + l.cost, 0));
  const fees = round6(legs.reduce((s, l) => s + l.fee, 0));
  const totalCost = round6(grossCost + fees);
  const payoutUsd = round6(q * payout);
  const netProfit = round6(payoutUsd - totalCost);
  const roi = totalCost > 0 ? netProfit / totalCost : 0;
  const days = closeTime ? (closeTime - nowSec) / 86_400 : null;
  return {
    stakeUsd,
    contracts: q,
    legs,
    grossCost,
    fees,
    totalCost,
    payoutUsd,
    netProfit,
    roi,
    apr: days && days > 0 ? roi * (365 / Math.max(days, 1)) : null,
    depthLimited: lo >= depth - 1e-9,
    belowMinimum: legs.map((l, i) => (l.deposit < minOrderUsd ? i : -1)).filter((i) => i >= 0),
  };
}
