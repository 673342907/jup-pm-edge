/**
 * Headless-browser smoke test + screenshots for the dashboard (not part of `npm test`: needs Chrome + network).
 * Starts the dashboard on an ephemeral port in-process, drives headless Chrome over CDP (test/cdp.ts), asserts
 * the rendered UI and the safety flow, writes docs/dashboard-*.png, checks the static demo from file://, then
 * stops Chrome and the server. Uses a random watch-only public key: nothing is ever signed.
 *   npm run test:ui            (CHROME=/path/to/chrome to override)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import type { Report } from '../src/report.ts';
import { createDashboardServer } from '../src/server.ts';
import { launch, type Page } from './cdp.ts';

const report = JSON.parse(readFileSync('samples/scan.json', 'utf8')) as Report;
const server = createDashboardServer({ report });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
console.log('dashboard on', base);
const browser = await launch();
/** A fake Wallet Standard wallet (watch-only): exposes a public key, REFUSES to sign, and counts sign attempts. */
const MOCK_WALLET = `(() => {
  window.__signAttempts = 0;
  const address = '4DRp7Jqivcmt3KGqGuoYSikzTZDGXUXLhD4VhL4iL78G';
  const account = { address, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: [] };
  const refuse = async () => { window.__signAttempts++; throw new Error('test wallet never signs'); };
  const wallet = { version: '1.0.0', name: 'Test Wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: ['solana:mainnet'], accounts: [],
    features: { 'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': { version: '1.0.0', signTransaction: refuse },
      'solana:signAndSendTransaction': { version: '1.0.0', signAndSendTransaction: refuse } } };
  window.addEventListener('wallet-standard:app-ready', (e) => e.detail.register(wallet));
})();`;
const text = (p: Page, sel: string) => p.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
const click = (p: Page, sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
const ok = (name: string) => console.log('  ✔', name);

try {
  // 1. Overview: KPIs + genuine sets table
  let p = await browser.open(base);
  await p.waitFor(`document.querySelectorAll('tr.row').length > 10`);
  const kpis = await text(p, '#kpis');
  for (const s of ['events scanned', 'open markets', 'verified arbs', 'trap baskets rejected', 'venue parity pass']) assert.ok(kpis.includes(s), s);
  assert.ok(kpis.includes('937') && kpis.includes('100.0%'));
  await p.screenshot(resolve('docs/dashboard-ui.png'));
  ok('KPI cards + genuine complete-set table');
  // sort by legs, filter by search
  await p.eval(`document.querySelector('th[data-sort="legs"]').click()`);
  await p.eval(`(() => { const i = document.querySelector('#q') || document.querySelector('input[type=search]'); i.value = 'Fed decisions'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.waitFor(`document.querySelectorAll('tr.row').length > 0 && document.querySelectorAll('tr.row').length < 10 && /Fed decisions/.test(document.querySelector('tr.row').innerText)`);
  ok('sort + search filter');
  await p.close();

  // 2. Traps view with the first trap expanded
  p = await browser.open(base + '#view=traps&expand=first');
  await p.waitFor(`document.querySelector('tr.expand')`);
  const why = await text(p, 'tr.expand');
  assert.match(why, /mutually exclusive|exhaustive/i);
  await p.screenshot(resolve('docs/dashboard-traps.png'));
  ok('trap toggle + expandable "why a naive bot loses"');
  await p.close();

  // 3. Genuine set drawer: stake calculator on live books, watch-only key, build unsigned (dry-run)
  p = await browser.open(base + '#drawer=top&demokey=1');
  await p.waitFor(`document.querySelector('#drawer:not([hidden]) #build')`);
  await p.waitFor(`/live books|snapshot/.test(document.querySelector('#drawer').innerText) && !document.querySelector('#drawer .spark')`, 45_000);
  const drawer = await text(p, '#drawer');
  assert.match(drawer, /Pre-sign safety review/i);
  assert.match(drawer, /DRY-RUN/);
  await p.eval(`(() => { const s = document.querySelector('#stake'); s.value = 250; s.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.waitFor(`/\\$250/.test(document.querySelector('#drawer').innerText)`);
  ok('stake slider re-prices on depth + fee curve');
  await click(p, '#build');
  await p.waitFor(`/leg 1 [✓✕]|Server refused/.test(document.querySelector('.log')?.innerText ?? '')`, 60_000);
  const log = await text(p, '.log');
  console.log('    build result:', log.split('\n').find((l) => /leg 1 [✓✕]|refused/.test(l)));
  assert.match(log, /leg 1 ✓ unsigned tx|unsupported_region/);
  await p.screenshot(resolve('docs/dashboard-drawer.png'));
  ok('build unsigned orders (dry-run) reaches Jupiter POST /orders; geo errors surfaced');
  await p.close();

  // 4. Trap drawer: live mode hard-blocked; dry-run only after explicit inspection, preview only
  p = await browser.open(base + '#view=traps&drawer=first', { init: MOCK_WALLET });
  await p.waitFor(`document.querySelector('#drawer:not([hidden]) #build') && !document.querySelector('#drawer #refresh')?.disabled`, 45_000);
  await click(p, '#wbtn');
  await p.waitFor(`document.querySelector('[data-wallet="Test Wallet"]')`);
  await click(p, '[data-wallet="Test Wallet"]');
  await p.waitFor(`/Test Wallet/.test(document.querySelector('#wallet-area').innerText)`);
  ok('Wallet Standard discovery + connect (mock wallet, public key only)');
  await click(p, '[data-mode="live"]');
  await p.waitFor(`document.querySelector('#build')?.disabled === true`);
  assert.match(await text(p, '#drawer'), /BLOCKED/);
  assert.equal(await p.eval(`document.querySelector('#sign')?.disabled ?? true`), true);
  assert.equal(await p.eval('window.__signAttempts'), 0);
  ok('trap basket hard-blocked in LIVE mode (sign button disabled, wallet never asked)');
  await click(p, '[data-mode="dry-run"]');
  await p.waitFor(`document.querySelector('#acktrap')`);
  await p.eval(`(() => { const c = document.querySelector('#acktrap'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await p.waitFor(`/Preview order payload/.test(document.querySelector('#build').innerText) || /cannot fill/.test(document.querySelector('#drawer').innerText)`);
  if (await p.eval(`!document.querySelector('#build').disabled`)) {
    await click(p, '#build');
    await p.waitFor(`/payload/i.test(document.querySelector('.log')?.innerText ?? '')`);
    assert.equal(await p.eval(`document.querySelector('#sign').disabled`), true);
  } else console.log('    (first trap has an empty leg on live books: depth block shown instead of a preview)');
  await p.screenshot(resolve('docs/dashboard-trap-blocked.png'));
  ok('trap in dry-run: inspect → payload preview only, never signable');
  await p.close();

  // 5. Parity tab
  p = await browser.open(base + '#tab=parity');
  await p.waitFor(`/kalshi/i.test(document.querySelector('#view').innerText)`);
  await p.screenshot(resolve('docs/dashboard-parity.png'));
  ok('venue parity audit tab');
  await p.close();

  // 6. Static demo from file:// (what GitHub/Cloudflare Pages serve)
  p = await browser.open('file://' + resolve('samples/demo.html'));
  await p.waitFor(`document.querySelectorAll('tr.row').length > 10`);
  assert.match(await text(p, 'header'), /static demo/i);
  ok('static demo renders embedded scan with no server');
  await p.close();
  console.log('ui smoke: ok; screenshots in docs/dashboard-*.png');
} finally {
  await browser.close();
  await new Promise<void>((r) => server.close(() => r()));
  server.closeAllConnections?.();
  console.log('chrome + server stopped');
}
