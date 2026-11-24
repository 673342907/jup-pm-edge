/**
 * pm-edge dashboard server. Built-in node:http only, zero runtime dependencies.
 *
 * Holds no keys and never signs. It (1) serves the dashboard, (2) serves the browser-safe pricing and safety
 * modules with types stripped, (3) proxies read-only Jupiter order books, (4) asks Jupiter for UNSIGNED order
 * transactions only after the server-side safety review passes against the server's own scan data, (5) relays
 * transactions the user's wallet already signed to Jupiter's /execute, and (6) proxies RPC simulateTransaction.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';
import { orderBodies } from './completeSet.ts';
import { HttpError, fetchJson, mapLimit, type Fetcher } from './http.ts';
import { JupiterPrediction } from './jupiter.ts';
import { askLadder, quoteStake, type Level, type StakeQuote } from './pricing.ts';
import type { Report } from './report.ts';
import { checkUnsignedTx, isValidPubkey, reviewExecution, type Mode } from './safety.ts';
import type { VerifiedSet } from './types.ts';

const ROOT = new URL('..', import.meta.url);
const file = (rel: string) => fileURLToPath(new URL(rel, ROOT));

export interface ServerOptions {
  report: Report | null;
  jup?: JupiterPrediction;
  /** Used for RPC simulation. */
  fetcher?: Fetcher;
  rpcUrl?: string;
  maxStakeUsd?: number;
  /** Runs a live scan; injected so tests never touch the network. */
  runScan?: (opts: { maxEvents: number; integritySample: number }) => Promise<Report>;
}

interface State {
  report: Report | null;
  index: Map<string, VerifiedSet>;
  scanning: boolean;
  scanStartedAt: string | null;
  lastScanError: string | null;
  source: 'file' | 'live-scan' | 'none';
}

const STATIC: Record<string, [string, string]> = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['web/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['web/app.js', 'text/javascript; charset=utf-8'],
  '/wallet.js': ['web/wallet.js', 'text/javascript; charset=utf-8'],
  '/app.css': ['web/app.css', 'text/css; charset=utf-8'],
};
/** Browser-safe TypeScript modules, served with types stripped. They have no imports by design. */
const STRIPPED: Record<string, string> = { '/lib/pricing.js': 'src/pricing.ts', '/lib/safety.js': 'src/safety.ts' };

const strippedCache = new Map<string, string>();
export function strippedModule(rel: string): string {
  if (!strippedCache.has(rel)) strippedCache.set(rel, stripTypeScriptTypes(readFileSync(file(rel), 'utf8')));
  return strippedCache.get(rel)!;
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://esm.sh", // esm.sh only for the legacy-wallet web3.js fallback
  "connect-src 'self' https: wss:", // Jupiter + user-chosen RPC, called from the browser when routing is "browser"
  "img-src 'self' data: https:",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

function indexReport(r: Report | null): Map<string, VerifiedSet> {
  const m = new Map<string, VerifiedSet>();
  if (!r) return m;
  for (const v of [...r.scan.verified, ...(r.scan.traps ?? []), ...(r.scan.unverified ?? [])]) m.set(v.candidate.id, v);
  return m;
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': CSP,
  });
  res.end(data);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new BadRequest('request body too large');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest('invalid JSON');
  }
}

class BadRequest extends Error {}

const errInfo = (e: unknown) => (e instanceof HttpError ? { status: e.status, code: e.body?.code ?? null, message: e.body?.message ?? e.message } : { status: null, code: null, message: (e as Error).message });

export function createDashboardServer(opts: ServerOptions): Server {
  const jup = opts.jup ?? new JupiterPrediction();
  const fetcher = opts.fetcher ?? fetchJson;
  const rpcUrl = opts.rpcUrl ?? process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const maxStakeUsd = opts.maxStakeUsd ?? 1_000;
  const state: State = { report: opts.report, index: indexReport(opts.report), scanning: false, scanStartedAt: null, lastScanError: null, source: opts.report ? 'file' : 'none' };

  /** Fresh ask ladders for every leg; falls back to the scan snapshot when `live` is false or a fetch fails. */
  async function legLadders(v: VerifiedSet, live: boolean): Promise<{ asks: Level[][]; source: 'live' | 'snapshot'; error?: string }> {
    if (live) {
      try {
        const asks = await mapLimit(v.candidate.legs, 6, async (l) => askLadder(await jup.orderbook(l.marketId), l.side));
        return { asks, source: 'live' };
      } catch (e) {
        if (v.asks) return { asks: v.asks, source: 'snapshot', error: errInfo(e).message };
        throw e;
      }
    }
    if (!v.asks) throw new BadRequest('no order-book snapshot for this basket; request live books');
    return { asks: v.asks, source: 'snapshot' };
  }

  function basket(id: string): VerifiedSet {
    const v = state.index.get(id);
    if (!v) throw new NotFound(`unknown basket ${id}`);
    return v;
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && STATIC[p]) {
      const [rel, type] = STATIC[p]!;
      return send(res, 200, readFileSync(file(rel), 'utf8'), type);
    }
    if (method === 'GET' && STRIPPED[p]) return send(res, 200, strippedModule(STRIPPED[p]!), 'text/javascript; charset=utf-8');

    if (method === 'GET' && p === '/api/health') return send(res, 200, { ok: true, hasReport: !!state.report, source: state.source });

    if (method === 'GET' && p === '/api/scan/latest') {
      if (!state.report) return send(res, 404, { error: 'no scan loaded yet; POST /api/scan' });
      return send(res, 200, { source: state.source, report: state.report });
    }
    if (method === 'GET' && p === '/api/scan/status') {
      return send(res, 200, { scanning: state.scanning, startedAt: state.scanStartedAt, lastError: state.lastScanError, generatedAt: state.report?.scan.generatedAt ?? null, source: state.source });
    }
    if (method === 'POST' && p === '/api/scan') {
      if (!opts.runScan) return send(res, 501, { error: 'live scanning disabled' });
      if (state.scanning) return send(res, 409, { error: 'a scan is already running', startedAt: state.scanStartedAt });
      const body = await readJson(req);
      const maxEvents = Math.min(Math.max(Number(body.maxEvents) || 600, 50), 3_000);
      const integritySample = Math.min(Math.max(Number(body.integritySample) || 20, 0), 60);
      state.scanning = true;
      state.scanStartedAt = new Date().toISOString();
      state.lastScanError = null;
      opts.runScan({ maxEvents, integritySample })
        .then((r) => {
          state.report = r;
          state.index = indexReport(r);
          state.source = 'live-scan';
        })
        .catch((e) => {
          state.lastScanError = (e as Error).message;
        })
        .finally(() => {
          state.scanning = false;
        });
      return send(res, 202, { status: 'running', maxEvents, integritySample });
    }

    const m = p.match(/^\/api\/basket\/(.+?)(\/quote)?$/);
    if (method === 'GET' && m) {
      const v = basket(decodeURIComponent(m[1]!));
      if (!m[2]) return send(res, 200, v);
      const stake = Number(url.searchParams.get('stake') ?? 100);
      if (!(stake > 0) || stake > maxStakeUsd) throw new BadRequest(`stake must be in (0, ${maxStakeUsd}]`);
      const { asks, source, error } = await legLadders(v, url.searchParams.get('live') !== '0');
      const quote = quoteStake(asks, v.candidate.payout, stake, { closeTime: v.candidate.closeTime });
      return send(res, 200, { basketId: v.candidate.id, source, error, fetchedAt: new Date().toISOString(), asks: asks.map((a) => a.slice(0, 25)), quote });
    }

    if (method === 'POST' && p === '/api/orders/build') {
      const b = await readJson(req);
      const mode: Mode = b.mode === 'live' ? 'live' : 'dry-run';
      const v = basket(String(b.basketId ?? ''));
      const stakeUsd = Number(b.stakeUsd);
      let quote: StakeQuote | null = null;
      let quoteSource: 'live' | 'snapshot' | 'none' = 'none';
      let quoteError: string | undefined;
      try {
        const l = await legLadders(v, true);
        quoteSource = l.source;
        quoteError = l.error;
        // A live signature must be priced on live books, never a stale snapshot.
        if (!(mode === 'live' && l.source !== 'live')) quote = quoteStake(l.asks, v.candidate.payout, stakeUsd, { closeTime: v.candidate.closeTime });
      } catch (e) {
        quoteError = errInfo(e).message;
      }
      // The review uses the SERVER's verdict for this basket id, never anything the client claims about it.
      const review = reviewExecution({
        mode,
        ownerPubkey: String(b.ownerPubkey ?? ''),
        verdict: v.verdict,
        exclusivityStatus: v.exclusivity.status,
        exclusivityNote: v.exclusivity.note,
        stakeUsd,
        maxStakeUsd,
        quote,
        acknowledgeTrap: b.acknowledgeTrap === true,
        acknowledgeLoss: b.acknowledgeLoss === true,
      });
      if (!review.canBuildUnsigned && !review.previewOnly) return send(res, 403, { error: 'blocked by safety review', review, quote, quoteSource, quoteError });
      const bodies = orderBodies(v.candidate.legs, quote!.legs.map((l) => l.deposit), String(b.ownerPubkey));
      if (review.previewOnly) {
        return send(res, 200, { built: false, previewOnly: true, review, quote, quoteSource, quoteError, legs: bodies.map((request) => ({ request })) });
      }
      const legs = [];
      for (const request of bodies) {
        try {
          const r = await jup.buildOrder(request);
          const txCheck = typeof r?.transaction === 'string' ? checkUnsignedTx(Buffer.from(r.transaction, 'base64'), request.ownerPubkey) : { name: 'tx-signer', status: 'block', detail: 'Jupiter returned no transaction' };
          legs.push({ request, transaction: r?.transaction ?? null, txMeta: r?.txMeta ?? null, execution: r?.execution ?? null, order: r?.order ?? null, txCheck });
        } catch (e) {
          legs.push({ request, error: errInfo(e) });
        }
      }
      return send(res, 200, { built: legs.every((l: any) => l.transaction), previewOnly: false, review, quote, quoteSource, quoteError, legs });
    }

    if (method === 'POST' && p === '/api/orders/execute') {
      const b = await readJson(req);
      if (typeof b.signedTransaction !== 'string' || b.signedTransaction.length > 8_000 || !/^[A-Za-z0-9+/=]+$/.test(b.signedTransaction)) throw new BadRequest('signedTransaction must be base64');
      try {
        return send(res, 200, await jup.execute(b.signedTransaction, b.context ?? null));
      } catch (e) {
        return send(res, 502, { error: errInfo(e) });
      }
    }

    if (method === 'POST' && p === '/api/simulate') {
      const b = await readJson(req);
      if (typeof b.transaction !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(b.transaction)) throw new BadRequest('transaction must be base64');
      try {
        const r: any = await fetcher(rpcUrl, {
          method: 'POST',
          body: { jsonrpc: '2.0', id: 1, method: 'simulateTransaction', params: [b.transaction, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }] },
        });
        if (r?.error) return send(res, 200, { ok: false, rpcError: r.error });
        const value = r?.result?.value ?? {};
        return send(res, 200, { ok: value.err == null, err: value.err ?? null, logs: value.logs ?? [], unitsConsumed: value.unitsConsumed ?? null });
      } catch (e) {
        return send(res, 502, { error: errInfo(e) });
      }
    }

    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }

  return createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof BadRequest) return send(res, 400, { error: e.message });
      if (e instanceof NotFound) return send(res, 404, { error: e.message });
      send(res, 500, { error: (e as Error).message });
    });
  });
}

class NotFound extends Error {}

/** Validate a pubkey for CLI use. */
export { isValidPubkey };
