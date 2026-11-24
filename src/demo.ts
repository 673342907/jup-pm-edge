/**
 * Static demo builder: one self-contained HTML file with the dashboard, the browser-safe pricing/safety
 * modules (types stripped) and a real scan embedded. Hostable on GitHub Pages / Cloudflare Pages with no
 * server, so judges anywhere can use the full UI. Jupiter calls (live books, unsigned order build) go from the
 * viewer's own browser, which also keeps the server out of Jupiter's US/KR geo-block.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Report } from './report.ts';
import { strippedModule } from './server.ts';

const ROOT = new URL('..', import.meta.url);
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, ROOT)), 'utf8');
const dataUrl = (js: string) => `data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`;

/** JSON safe to embed inside <script>: no "</script>", no HTML comment openers, no U+2028/2029 surprises. */
export function scriptSafeJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Drop data the static UI never shows to keep the file small. */
export function slimReport(r: Report): Report {
  const strip = (v: any) => ({ ...v, candidate: { ...v.candidate, legs: v.candidate.legs.map((l: any) => ({ marketId: l.marketId, title: l.title, side: l.side, quote: l.quote })) } });
  return { ...r, scan: { ...r.scan, verified: r.scan.verified.map(strip), traps: (r.scan.traps ?? []).map((t: any) => ({ ...strip(t), asks: undefined })), unverified: (r.scan.unverified ?? []).map(strip), tightest: [] } };
}

export function buildDemoHtml(report: Report): string {
  const imports = {
    imports: {
      './lib/pricing.js': dataUrl(strippedModule('src/pricing.ts')),
      './lib/safety.js': dataUrl(strippedModule('src/safety.ts')),
      './wallet.js': dataUrl(read('web/wallet.js')),
    },
  };
  const head = [
    `<style>${read('web/app.css')}</style>`,
    `<script type="importmap">${JSON.stringify(imports)}</script>`,
    `<script>window.__PM_EDGE_DEMO__ = { builtAt: ${JSON.stringify(new Date().toISOString())}, report: ${scriptSafeJson(slimReport(report))} };</script>`,
  ].join('\n');
  return read('web/index.html')
    .replace('<link rel="stylesheet" href="./app.css">', '')
    .replace('<!--PM_EDGE_INLINE_HEAD-->', head)
    .replace('<script type="module" src="./app.js"></script>', `<script type="module">\n${read('web/app.js')}\n</script>`);
}
