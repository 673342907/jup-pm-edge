import { buildCandidates, legAsks, orderPlan, quotedEdge, sizeCompleteSet, type SizingOptions } from './completeSet.ts';
import { mapLimit } from './http.ts';
import { JupiterPrediction } from './jupiter.ts';
import { bestAsk, round6 } from './orderbook.ts';
import type { CompleteSetCandidate, Exclusivity, JupEvent, JupOrderbook, VerifiedSet } from './types.ts';
import { Kalshi, Polymarket, type SourceEventInfo } from './venues.ts';

export interface ScanOptions extends SizingOptions {
  /** Verify candidates whose quoted cost is within this fraction of payout (0.01 = within 1%). */
  screen?: number;
  /** Hard cap on how many genuine complete sets get orderbook verification. */
  maxVerify?: number;
  /** Hard cap on how many screened baskets get a source-venue structure check. */
  maxSourceChecks?: number;
  concurrency?: number;
}

export interface ScanStats {
  events: number;
  markets: number;
  openMarkets: number;
  candidates: Record<string, number>;
  /** Median quoted overround (cost / payout - 1) per set kind, a market-efficiency gauge. */
  medianOverroundPct: Record<string, number>;
  screened: number;
  sourceChecked?: number;
  traps?: number;
  unverified?: number;
  bookChecked?: number;
  /** Rejected baskets whose quotes alone sum to less than the payout: what a naive scanner would call "free money". */
  naiveFalsePositives?: number;
  trapReasons?: Record<string, number>;
}

export interface ScanResult {
  generatedAt: string;
  stats: ScanStats;
  verified: VerifiedSet[];
  /** Baskets that look like free money on quotes but are not complete sets (top examples). */
  traps: VerifiedSet[];
  unverified: VerifiedSet[];
  tightest: CompleteSetCandidate[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : NaN;
};

export function setStats(events: JupEvent[], cands: CompleteSetCandidate[], screened: number): ScanStats {
  const kinds = [...new Set(cands.map((c) => c.kind))];
  const candidates: Record<string, number> = {};
  const medianOverroundPct: Record<string, number> = {};
  for (const k of kinds) {
    const cs = cands.filter((c) => c.kind === k);
    candidates[k] = cs.length;
    medianOverroundPct[k] = Math.round(median(cs.map((c) => (c.quotedCost / c.payout - 1) * 100)) * 100) / 100;
  }
  const markets = events.flatMap((e) => e.markets);
  return { events: events.length, markets: markets.length, openMarkets: markets.filter((m) => m.status === 'open').length, candidates, medianOverroundPct, screened };
}

/**
 * Decide whether a multi-outcome basket really is a complete set, using the source venue as ground truth.
 *
 *  - NO on every outcome pays >= $(n-1) as long as at most one outcome can resolve YES, so it only needs
 *    mutual exclusivity (if nothing resolves YES it pays $n, which is better).
 *  - YES on every outcome pays $1 only if exactly one outcome must resolve YES, so it also needs exhaustiveness:
 *    Polymarket negRisk without negRiskAugmented placeholders, and Jupiter must list every open outcome.
 *    Kalshi publishes no exhaustiveness flag, so Kalshi YES baskets stay UNVERIFIED.
 */
export async function checkExclusivity(c: CompleteSetCandidate, ev: JupEvent, poly: Polymarket, kalshi: Kalshi): Promise<Exclusivity> {
  if (c.kind === 'binary-yes-no') return { status: 'structural', note: 'YES and NO of the same market' };
  if (c.kind === 'condition-pair') return { status: 'structural', note: 'every outcome of one Polymarket binary condition' };
  let info: SourceEventInfo;
  try {
    info = c.provider === 'polymarket' ? await poly.eventInfo(ev.eventId) : await kalshi.eventInfo(ev.eventId);
  } catch (e) {
    return { status: 'unverified', note: `source lookup failed: ${(e as Error).message.slice(0, 120)}` };
  }
  if (!info.mutuallyExclusive) return { status: 'rejected', note: `${info.note}: outcomes are not mutually exclusive` };
  const legIds = c.legs.map((l) => (c.provider === 'polymarket' ? ev.markets.find((m) => m.marketId === l.marketId)?.conditionId ?? '' : l.marketId));
  const unknown = legIds.filter((id) => !info.openIds.includes(id));
  if (unknown.length) return { status: 'rejected', note: `${info.note}; ${unknown.length} Jupiter legs not found among the source event's open markets` };

  if (c.kind === 'multi-outcome-no') {
    return { status: 'verified', note: `${info.note}; mutually exclusive, so NO on all ${legIds.length} listed outcomes pays at least $${c.payout}` };
  }
  // multi-outcome-yes
  if (info.exhaustive === null) return { status: 'unverified', note: `${info.note}; venue does not guarantee one listed outcome wins, so a YES basket can lose everything` };
  if (!info.exhaustive) return { status: 'rejected', note: `${info.note}; NOT exhaustive (placeholder / "Other" outcomes can win), YES basket can expire worthless` };
  const missing = info.openIds.filter((id) => !legIds.includes(id));
  if (missing.length) return { status: 'rejected', note: `${info.note}; Jupiter is missing ${missing.length} open outcome(s)` };
  return { status: 'verified', note: `${info.note}; exhaustive and Jupiter lists all ${legIds.length} outcomes` };
}

/** Top trap examples, round-robin across rejection reasons so every failure mode shows up in reports. */
export const trapReason = (t: VerifiedSet) =>
  /negRiskAugmented=true|NOT exhaustive/.test(t.exclusivity.note) ? 'non-exhaustive'
  : /not mutually exclusive/.test(t.exclusivity.note) ? 'not-exclusive'
  : /missing/.test(t.exclusivity.note) ? 'missing-outcome'
  : 'other';

export function diverseTraps(traps: VerifiedSet[], n: number): VerifiedSet[] {
  const reason = trapReason;
  const buckets = new Map<string, VerifiedSet[]>();
  for (const t of traps) buckets.set(reason(t), [...(buckets.get(reason(t)) ?? []), t]);
  const out: VerifiedSet[] = [];
  while (out.length < n && [...buckets.values()].some((b) => b.length)) {
    for (const b of buckets.values()) if (b.length && out.length < n) out.push(b.shift()!);
  }
  return out;
}

export async function scan(
  opts: ScanOptions & { maxEvents?: number; provider?: string } = {},
  jup = new JupiterPrediction(),
  poly = new Polymarket(),
  kalshi = new Kalshi(),
): Promise<ScanResult & { events: JupEvent[] }> {
  const { screen = 0.01, maxVerify = 120, concurrency = 6, maxSourceChecks = 2_000 } = opts;
  const events = await jup.listEvents({ maxEvents: opts.maxEvents, provider: opts.provider });
  const evById = new Map(events.map((e) => [e.eventId, e]));
  const cands = buildCandidates(events);

  const ranked = [...cands].sort((a, b) => quotedEdge(b) / b.payout - quotedEdge(a) / a.payout);
  const screened = ranked.filter((c) => c.quotedCost <= c.payout * (1 + screen));

  // Stage 1: ground-truth the basket structure at the source venue (cheap, one call per event, cached).
  // Structural baskets need no lookup; multi-outcome baskets are capped by maxSourceChecks.
  let multiBudget = maxSourceChecks;
  const toCheck = screened.filter((c) => !c.kind.startsWith('multi') || multiBudget-- > 0);
  const excl = await mapLimit(toCheck, concurrency, (c) => checkExclusivity(c, evById.get(c.eventId)!, poly, kalshi));
  const traps: VerifiedSet[] = [];
  const unverified: VerifiedSet[] = [];
  const passed: { c: CompleteSetCandidate; exclusivity: Exclusivity }[] = [];
  toCheck.forEach((c, i) => {
    const exclusivity = excl[i]!;
    if (exclusivity.status === 'rejected') traps.push({ candidate: c, exclusivity, bookCost: null, sized: null, verdict: 'NOT-A-COMPLETE-SET' });
    else if (exclusivity.status === 'unverified') unverified.push({ candidate: c, exclusivity, bookCost: null, sized: null, verdict: 'UNVERIFIED' });
    else passed.push({ c, exclusivity });
  });

  // Stage 2: live orderbooks for the best genuine complete sets only; each book fetched once.
  const shortlist = passed.slice(0, maxVerify);
  const marketIds = [...new Set(shortlist.flatMap(({ c }) => c.legs.map((l) => l.marketId)))];
  const books = new Map<string, JupOrderbook>();
  await mapLimit(marketIds, concurrency, async (id) => {
    try {
      books.set(id, await jup.orderbook(id));
    } catch {
      /* missing book => NO-DEPTH */
    }
  });

  const verified = shortlist.map(({ c, exclusivity }): VerifiedSet => {
    const asks = legAsks(c, books);
    const bests = asks.map((a) => bestAsk(a));
    const bookCost = bests.some((b) => b == null) ? null : round6(bests.reduce<number>((s, b) => s + (b ?? 0), 0));
    if (bookCost == null) return { candidate: c, exclusivity, bookCost, sized: null, verdict: 'NO-DEPTH' };
    const sized = sizeCompleteSet(asks, c.payout, c.closeTime, opts);
    if (sized && sized.netProfit > 0) return { candidate: c, exclusivity, bookCost, sized, verdict: 'ARB', orders: orderPlan(c, sized) };
    return { candidate: c, exclusivity, bookCost, sized, verdict: 'NO-EDGE-AFTER-FEES' };
  });
  verified.sort((a, b) => (b.sized?.netProfit ?? -Infinity) - (a.sized?.netProfit ?? -Infinity) || (a.bookCost ?? 9) / a.candidate.payout - (b.bookCost ?? 9) / b.candidate.payout);

  return {
    generatedAt: new Date().toISOString(),
    stats: {
      ...setStats(events, cands, screened.length),
      sourceChecked: toCheck.length,
      traps: traps.length,
      naiveFalsePositives: traps.filter((t) => t.candidate.quotedCost < t.candidate.payout).length,
      trapReasons: traps.reduce<Record<string, number>>((acc, t) => ((acc[trapReason(t)] = (acc[trapReason(t)] ?? 0) + 1), acc), {}), unverified: unverified.length, bookChecked: shortlist.length },
    verified,
    traps: diverseTraps(traps, 15),
    unverified: unverified.slice(0, 10),
    tightest: ranked.slice(0, 15),
    events,
  };
}
