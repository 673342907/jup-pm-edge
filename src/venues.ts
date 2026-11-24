/** Read-only clients for the venues whose liquidity Jupiter Prediction routes to. */
import { fetchJson, type Fetcher } from './http.ts';
import { bestAsk, bestBid } from './orderbook.ts';

export const POLY_GAMMA = 'https://gamma-api.polymarket.com';
export const POLY_CLOB = 'https://clob.polymarket.com';
export const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';

export interface Quote {
  bid: number | null;
  ask: number | null;
}

export interface SourceEventInfo {
  mutuallyExclusive: boolean;
  /**
   * true  = the venue guarantees exactly one listed outcome resolves YES (no placeholders, no "someone else").
   * false = the venue says the listed outcomes may all resolve NO (e.g. Polymarket negRiskAugmented placeholders).
   * null  = the venue does not say (Kalshi has no exhaustiveness flag).
   */
  exhaustive: boolean | null;
  /** Identifiers of every still-tradable outcome market at the source venue. */
  activeIds: string[];
  /** Identifiers of every not-yet-closed market, including inactive placeholders such as "Team A" / "Other". */
  openIds: string[];
  note: string;
}

export class Polymarket {
  private readonly fetcher: Fetcher;
  private readonly cache = new Map<string, Promise<SourceEventInfo>>();
  constructor(fetcher: Fetcher = fetchJson) {
    this.fetcher = fetcher;
  }

  /** Best bid/ask for one CLOB outcome token. */
  async quote(tokenId: string): Promise<Quote> {
    const b = (await this.fetcher(`${POLY_CLOB}/book?token_id=${tokenId}`)) as any;
    const lv = (xs: any[] = []) => xs.map((x) => ({ price: Number(x.price), qty: Number(x.size) })).filter((l) => l.qty > 0);
    return { bid: bestBid(lv(b?.bids)), ask: bestAsk(lv(b?.asks)) };
  }

  /** `POLY-<gammaEventId>` -> negRisk flags and condition ids (memoised per event). */
  eventInfo(jupEventId: string): Promise<SourceEventInfo> {
    if (!this.cache.has(jupEventId)) this.cache.set(jupEventId, this.loadEvent(jupEventId));
    return this.cache.get(jupEventId)!;
  }

  private async loadEvent(jupEventId: string): Promise<SourceEventInfo> {
    const id = jupEventId.replace(/^POLY-/, '');
    const e = (await this.fetcher(`${POLY_GAMMA}/events/${id}`)) as any;
    const markets: any[] = e?.markets ?? [];
    const notClosed = markets.filter((m) => !m.closed);
    const active = notClosed.filter((m) => m.active);
    const placeholders = notClosed.length - active.length;
    const augmented = e?.negRiskAugmented === true;
    return {
      mutuallyExclusive: e?.negRisk === true,
      exhaustive: e?.negRisk === true && !augmented && placeholders === 0,
      activeIds: active.map((m) => String(m.conditionId)),
      openIds: notClosed.map((m) => String(m.conditionId)),
      note: `Polymarket event ${id}: negRisk=${e?.negRisk === true}, negRiskAugmented=${augmented}, ${active.length} active + ${placeholders} placeholder markets`,
    };
  }
}

export class Kalshi {
  private readonly fetcher: Fetcher;
  private readonly cache = new Map<string, Promise<SourceEventInfo>>();
  constructor(fetcher: Fetcher = fetchJson) {
    this.fetcher = fetcher;
  }

  /** Kalshi books hold YES bids and NO bids; a NO bid at p is a YES offer at 1 - p. */
  async quote(ticker: string): Promise<Quote> {
    const r = (await this.fetcher(`${KALSHI}/markets/${encodeURIComponent(ticker)}/orderbook`)) as any;
    const ob = r?.orderbook_fp ?? r?.orderbook ?? {};
    const lv = (xs: any[] | null | undefined) => (xs ?? []).map((x) => ({ price: Number(x[0]), qty: Number(x[1]) })).filter((l) => l.qty > 0);
    const yes = lv(ob.yes_dollars);
    const no = lv(ob.no_dollars);
    const bestNo = bestBid(no);
    return { bid: bestBid(yes), ask: bestNo == null ? null : Math.round((1 - bestNo) * 1e6) / 1e6 };
  }

  eventInfo(eventTicker: string): Promise<SourceEventInfo> {
    if (!this.cache.has(eventTicker)) this.cache.set(eventTicker, this.loadEvent(eventTicker));
    return this.cache.get(eventTicker)!;
  }

  private async loadEvent(eventTicker: string): Promise<SourceEventInfo> {
    const r = (await this.fetcher(`${KALSHI}/events/${encodeURIComponent(eventTicker)}`)) as any;
    const all: any[] = r?.markets ?? [];
    const active = all.filter((m) => ['active', 'open'].includes(String(m.status)));
    const notSettled = all.filter((m) => !['settled', 'finalized', 'determined'].includes(String(m.status)));
    return {
      mutuallyExclusive: r?.event?.mutually_exclusive === true,
      exhaustive: null,
      activeIds: active.map((m) => String(m.ticker)),
      openIds: notSettled.map((m) => String(m.ticker)),
      note: `Kalshi event ${eventTicker}: mutually_exclusive=${r?.event?.mutually_exclusive === true}, ${active.length} active markets`,
    };
  }
}
