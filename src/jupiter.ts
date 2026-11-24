import { fetchJson, mapLimit, type Fetcher } from './http.ts';
import { parseJupOrderbook } from './orderbook.ts';
import type { JupEvent, JupMarket, JupOrderbook } from './types.ts';

export const JUP_BASE = process.env.JUP_PREDICTION_BASE ?? 'https://api.jup.ag/prediction/v1';

/** Jupiter prices are micro-USD integers (1_000_000 = $1). 0 / missing means "no quote on this side". */
export const microToUsd = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n / 1e6 : null;
};

function toMarket(raw: any, ev: any): JupMarket {
  const p = raw.pricing ?? {};
  const opts: any[] = Array.isArray(raw.marketOptions) ? raw.marketOptions : [];
  return {
    marketId: String(raw.marketId),
    eventId: String(ev.eventId),
    provider: String(raw.provider ?? ''),
    title: String(raw.title ?? ''),
    status: String(raw.status ?? ''),
    closeTime: raw.closeTime ? Number(raw.closeTime) : null,
    buyYes: microToUsd(p.buyYesPriceUsd),
    sellYes: microToUsd(p.sellYesPriceUsd),
    buyNo: microToUsd(p.buyNoPriceUsd),
    sellNo: microToUsd(p.sellNoPriceUsd),
    volume: Number(p.volume ?? 0),
    conditionId: raw.conditionId ?? null,
    clobTokenIds: Array.isArray(raw.clobTokenIds) ? raw.clobTokenIds.map(String) : null,
    outcomes: Array.isArray(raw.outcomes) ? raw.outcomes.map(String) : null,
    yesLabels: opts.filter((o) => o.buyYes).map((o) => String(o.label)),
  };
}

export function toEvent(raw: any): JupEvent {
  const md = raw.metadata ?? {};
  const markets: JupMarket[] = (raw.markets ?? []).map((m: any) => toMarket(m, raw));
  const closeIso = md.closeTime ? Date.parse(md.closeTime) / 1000 : NaN;
  return {
    eventId: String(raw.eventId),
    title: String(md.title ?? raw.eventId),
    category: String(raw.category ?? ''),
    provider: markets[0]?.provider ?? (String(raw.eventId).startsWith('POLY-') ? 'polymarket' : 'kalshi'),
    series: md.series ?? null,
    closeTime: Number.isFinite(closeIso) ? closeIso : (markets.find((m) => m.closeTime)?.closeTime ?? null),
    volumeUsd: Number(raw.volumeUsd ?? 0) / 1e6,
    markets,
  };
}

export class JupiterPrediction {
  private readonly fetcher: Fetcher;
  private readonly headers: Record<string, string>;
  constructor(fetcher: Fetcher = fetchJson, apiKey = process.env.JUP_API_KEY) {
    this.fetcher = fetcher;
    this.headers = apiKey ? { 'x-api-key': apiKey } : {};
  }

  private get(path: string) {
    return this.fetcher(`${JUP_BASE}${path}`, { headers: this.headers });
  }

  /**
   * Page through GET /events (100 per page, highest volume first) for each provider. The API defaults to
   * provider=polymarket, so Kalshi-sourced events are only visible when asked for explicitly.
   * `maxEvents` applies per provider.
   */
  async listEvents(opts: { provider?: string; maxEvents?: number; pageSize?: number; concurrency?: number } = {}): Promise<JupEvent[]> {
    const providers = (opts.provider ?? 'polymarket,kalshi').split(',').map((p) => p.trim()).filter(Boolean);
    const all: JupEvent[] = [];
    for (const p of providers) all.push(...(await this.listProvider(p, opts)));
    return all;
  }

  private async listProvider(provider: string, opts: { maxEvents?: number; pageSize?: number; concurrency?: number }): Promise<JupEvent[]> {
    const { maxEvents = 3_000, pageSize = 100, concurrency = 4 } = opts;
    const q = (start: number) => {
      const p = new URLSearchParams({ start: String(start), end: String(start + pageSize), includeMarkets: 'true', provider, sortBy: 'volume', sortDirection: 'desc' });
      return `/events?${p}`;
    };
    const events: JupEvent[] = [];
    let start = 0;
    let more = true;
    while (more && start < maxEvents) {
      const starts: number[] = [];
      for (let i = 0; i < concurrency && start + i * pageSize < maxEvents; i++) starts.push(start + i * pageSize);
      const pages = await mapLimit(starts, concurrency, (s) => this.get(q(s)) as Promise<any>);
      for (const page of pages) {
        for (const e of page?.data ?? []) events.push(toEvent(e));
        if (!page?.pagination?.hasNext || (page?.data ?? []).length === 0) more = false;
      }
      start += starts.length * pageSize;
    }
    // De-duplicate in case the feed shifted while paging.
    const seen = new Map<string, JupEvent>();
    for (const e of events) if (!seen.has(e.eventId)) seen.set(e.eventId, e);
    return [...seen.values()].slice(0, maxEvents);
  }

  async orderbook(marketId: string): Promise<JupOrderbook> {
    return parseJupOrderbook(await this.get(`/orderbook/${encodeURIComponent(marketId)}`));
  }

  /** POST /orders: Jupiter builds an UNSIGNED transaction for `ownerPubkey`. Nothing is signed here. */
  buildOrder(body: object): Promise<any> {
    return this.fetcher(`${JUP_BASE}/orders`, { method: 'POST', body, headers: this.headers, timeoutMs: 20_000 });
  }

  /** POST /execute: relay a transaction the user's wallet already signed, with the build's `execution.context`. */
  execute(signedTransaction: string, context: unknown): Promise<any> {
    return this.fetcher(`${JUP_BASE}/execute`, { method: 'POST', body: { signedTransaction, context }, headers: this.headers, timeoutMs: 30_000 });
  }

  async tradingActive(): Promise<boolean> {
    const r = (await this.get('/trading-status')) as any;
    return Boolean(r?.trading_active);
  }
}
