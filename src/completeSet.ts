/**
 * Complete-set ("Dutch book") detection.
 *
 * A complete set is a basket of contracts that pays a fixed amount whatever happens. If Jupiter lets you buy
 * the whole basket for less than that payout (after fees), the difference is locked in at resolution.
 *
 *   binary-yes-no      YES + NO of one market                                   pays $1
 *   condition-pair     Polymarket 2-outcome condition split by Jupiter into two
 *                      markets (e.g. "Bengals" / "Commanders"): YES on both     pays $1
 *   multi-outcome-yes  YES on every outcome of a mutually exclusive event       pays $1
 *   multi-outcome-no   NO on every outcome of that event                        pays $(n-1)
 *
 * The first two are complete by construction. Multi-outcome sets are only complete when the source venue says
 * outcomes are mutually exclusive (Polymarket negRisk / Kalshi mutually_exclusive) AND Jupiter lists every
 * active outcome. Anything else is reported as UNVERIFIED and never counted as an arbitrage.
 */
import { tradingFee } from './fees.ts';
import { askLadder, costToBuy, round6 } from './orderbook.ts';
import type { OrderRequest, CompleteSetCandidate, JupEvent, JupMarket, JupOrderbook, Level, SetLeg, SizedOpportunity } from './types.ts';

const isOpen = (m: JupMarket) => m.status === 'open';

export const basketId = (kind: string, legs: { marketId: string; side: string }[]) => `${kind}:${legs.map((l) => `${l.marketId}.${l.side}`).join('+')}`;

function candidate(ev: JupEvent, kind: CompleteSetCandidate['kind'], legs: SetLeg[], payout: number): CompleteSetCandidate {
  return {
    id: basketId(kind, legs),
    kind,
    eventId: ev.eventId,
    eventTitle: ev.title,
    provider: ev.provider,
    category: ev.category,
    closeTime: legs.length ? ev.markets.find((m) => m.marketId === legs[0]!.marketId)?.closeTime ?? ev.closeTime : ev.closeTime,
    legs,
    quotedCost: round6(legs.reduce((s, l) => s + l.quote, 0)),
    payout,
  };
}

/** Enumerate every complete-set basket that Jupiter quotes on both/all sides. Uses listing quotes only (no extra calls). */
export function buildCandidates(events: JupEvent[]): CompleteSetCandidate[] {
  const out: CompleteSetCandidate[] = [];
  for (const ev of events) {
    const open = ev.markets.filter(isOpen);

    // 1) YES + NO inside a single market.
    for (const m of open) {
      if (m.buyYes != null && m.buyNo != null) {
        out.push(candidate(ev, 'binary-yes-no', [
          { marketId: m.marketId, title: m.title, side: 'yes', quote: m.buyYes },
          { marketId: m.marketId, title: m.title, side: 'no', quote: m.buyNo },
        ], 1));
      }
    }

    // 2) Polymarket binary conditions that Jupiter exposes as one market per outcome.
    const byCond = new Map<string, JupMarket[]>();
    for (const m of open) {
      if (!m.conditionId || !m.outcomes || m.outcomes.length !== 2 || m.yesLabels.length !== 1) continue;
      byCond.set(m.conditionId, [...(byCond.get(m.conditionId) ?? []), m]);
    }
    const pairedConditions = new Set<string>();
    for (const [cond, ms] of byCond) {
      const outcomes = ms[0]!.outcomes!;
      const legs: SetLeg[] = [];
      for (const o of outcomes) {
        const m = ms.find((x) => x.yesLabels[0] === o && x.buyYes != null);
        if (m) legs.push({ marketId: m.marketId, title: m.title, side: 'yes', quote: m.buyYes! });
      }
      if (legs.length === outcomes.length) {
        pairedConditions.add(cond);
        out.push(candidate(ev, 'condition-pair', legs, 1));
      }
    }

    // 3) Multi-outcome events: one market per outcome, none of them part of a split condition.
    const multi = open.filter((m) => !(m.conditionId && pairedConditions.has(m.conditionId)));
    if (multi.length >= 2 && multi.length === open.length) {
      if (multi.every((m) => m.buyYes != null)) {
        out.push(candidate(ev, 'multi-outcome-yes', multi.map((m) => ({ marketId: m.marketId, title: m.title, side: 'yes' as const, quote: m.buyYes! })), 1));
      }
      if (multi.length >= 3 && multi.every((m) => m.buyNo != null)) {
        out.push(candidate(ev, 'multi-outcome-no', multi.map((m) => ({ marketId: m.marketId, title: m.title, side: 'no' as const, quote: m.buyNo! })), multi.length - 1));
      }
    }
  }
  return out;
}

/** Edge per set, in USD, from listing quotes (before fees and depth). */
export const quotedEdge = (c: CompleteSetCandidate) => round6(c.payout - c.quotedCost);

export interface SizingOptions {
  /** Maximum USD to deploy across all legs. */
  budgetUsd?: number;
  /** Jupiter minimum order size per leg, USD. */
  minOrderUsd?: number;
  nowSec?: number;
}

/**
 * Depth-aware sizing. Walks every leg's ask ladder at once and evaluates profit at each depth breakpoint
 * (plus the per-leg minimum-order thresholds). Fees are charged per leg on the volume-weighted average price;
 * because p(1-p) is concave this is never lower than charging each fill separately, i.e. it is conservative.
 */
export function sizeCompleteSet(asks: Level[][], payout: number, closeTime: number | null, opts: SizingOptions = {}): SizedOpportunity | null {
  const { budgetUsd = 1_000, minOrderUsd = 5, nowSec = Date.now() / 1000 } = opts;
  if (!asks.length || asks.some((a) => a.length === 0)) return null;
  const depth = Math.min(...asks.map((a) => a.reduce((s, l) => s + l.qty, 0)));

  // Candidate quantities: every cumulative-depth breakpoint on any leg.
  const qs = new Set<number>();
  for (const a of asks) {
    let cum = 0;
    for (const l of a) {
      cum += l.qty;
      if (cum <= depth) qs.add(round6(cum));
    }
  }
  qs.add(round6(depth));
  // Minimum-order thresholds: smallest q where each leg costs >= minOrderUsd.
  for (const a of asks) {
    const best = a[0]!.price;
    if (best > 0) qs.add(Math.ceil((minOrderUsd / best) * 100) / 100);
  }

  const evaluate = (q: number): SizedOpportunity | null => {
    if (q <= 0 || q > depth + 1e-9) return null;
    const legCosts = asks.map((a) => costToBuy(a, q));
    if (legCosts.some((c) => c == null)) return null;
    const costs = legCosts as number[];
    if (costs.some((c) => c < minOrderUsd - 1e-9)) return null;
    const grossCost = costs.reduce((s, c) => s + c, 0);
    const avg = costs.map((c) => c / q);
    const fees = avg.reduce((s, p) => s + tradingFee(q, p), 0);
    if (grossCost + fees > budgetUsd) return null;
    const netProfit = q * payout - grossCost - fees;
    const roi = netProfit / (grossCost + fees);
    const days = closeTime ? (closeTime - nowSec) / 86_400 : null;
    const apr = days && days > 0 ? roi * (365 / Math.max(days, 1)) : null;
    return { contracts: round6(q), grossCost: round6(grossCost), fees: round6(fees), netProfit: round6(netProfit), roi, apr, avgLegPrices: avg.map(round6) };
  };

  // If the budget binds before depth does, also test the largest affordable quantity.
  const perSet = asks.reduce((s, a) => s + a[0]!.price, 0) * 1.05;
  if (perSet > 0) qs.add(Math.floor((budgetUsd / perSet) * 100) / 100);

  let best: SizedOpportunity | null = null;
  for (const q of [...qs].sort((a, b) => a - b)) {
    const r = evaluate(q);
    if (r && (!best || r.netProfit > best.netProfit)) best = r;
  }
  return best;
}

/** Ask ladders for every leg of a candidate, from live Jupiter orderbooks. */
export function legAsks(c: CompleteSetCandidate, books: Map<string, JupOrderbook>): Level[][] {
  return c.legs.map((l) => {
    const b = books.get(l.marketId);
    return b ? askLadder(b, l.side) : [];
  });
}

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * `POST /prediction/v1/orders` bodies, one per leg. Per Jupiter's API reference, buys are sized by
 * `depositAmount` (native USDC units); the contract-quantity fields are for sells only. The deposit covers the
 * leg's volume-weighted cost plus its fee, rounded up to the micro-USDC. Nothing here signs or submits.
 */
export function orderBodies(legs: { marketId: string; side: 'yes' | 'no' }[], depositsUsd: number[], ownerPubkey = '<YOUR_WALLET_PUBKEY>'): OrderRequest[] {
  return legs.map((l, i) => ({
    ownerPubkey,
    marketId: l.marketId,
    isYes: l.side === 'yes',
    isBuy: true,
    depositAmount: String(Math.ceil(depositsUsd[i]! * 1e6 - 1e-6)),
    depositMint: USDC_MINT,
  }));
}

export function orderPlan(c: CompleteSetCandidate, sized: SizedOpportunity, ownerPubkey = '<YOUR_WALLET_PUBKEY>'): OrderRequest[] {
  const deposits = c.legs.map((_, i) => {
    const avg = sized.avgLegPrices[i]!;
    return avg * sized.contracts + tradingFee(sized.contracts, avg);
  });
  return orderBodies(c.legs, deposits, ownerPubkey);
}
