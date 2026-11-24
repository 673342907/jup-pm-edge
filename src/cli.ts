#!/usr/bin/env node
/**
 * pm-edge — read-only scanner for Jupiter Prediction Markets on Solana.
 *
 *   pm-edge scan       [--max-events 3000 (per provider, top by volume)] [--provider polymarket,kalshi[,bisonfi]]
 *                      [--screen 0.01] [--max-source-checks 2000] [--max-verify 120]
 *                      [--budget 1000] [--integrity-sample 40] [--out DIR] [--json]
 *   pm-edge integrity  [--max-events N] [--sample 40] [--out DIR]
 *   pm-edge render     <scan.json> --out DIR                               (re-render reports from a saved scan)
 *   pm-edge serve      [--data samples/scan.json] [--port 8787] [--host 127.0.0.1]  (dashboard + wallet-signed execution UI)
 *   pm-edge build-demo [--data samples/scan.json] [--out samples/demo.html] [--site site]  (static, self-contained demo)
 *   pm-edge watch      [--interval 120] [--min-profit 1] ...scan flags      (prints only new ARB rows)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { runIntegrity, sampleMarkets, summarise } from './integrity.ts';
import { JupiterPrediction } from './jupiter.ts';
import { toConsole, toHtml, toMarkdown, type Report } from './report.ts';
import { scan } from './scan.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'max-events': { type: 'string', default: '3000' },
    provider: { type: 'string', default: 'polymarket,kalshi' },
    'max-source-checks': { type: 'string', default: '2000' },
    screen: { type: 'string', default: '0.01' },
    'max-verify': { type: 'string', default: '120' },
    budget: { type: 'string', default: '1000' },
    'integrity-sample': { type: 'string', default: '0' },
    sample: { type: 'string', default: '40' },
    out: { type: 'string' },
    json: { type: 'boolean', default: false },
    interval: { type: 'string', default: '120' },
    'min-profit': { type: 'string', default: '1' },
    help: { type: 'boolean', short: 'h', default: false },
    data: { type: 'string', default: 'samples/scan.json' },
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    site: { type: 'string', default: 'site' },
  },
});

const cmd = positionals[0] ?? 'scan';
const num = (k: keyof typeof values) => Number(values[k]);

function write(dir: string, report: Report, raw: unknown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.md'), toMarkdown(report));
  writeFileSync(join(dir, 'report.html'), toHtml(report));
  writeFileSync(join(dir, 'scan.json'), JSON.stringify(raw, null, 2));
  console.error(`wrote ${dir}/report.md, report.html, scan.json`);
}

async function runScan(): Promise<Report> {
  const t0 = Date.now();
  const res = await scan({
    maxEvents: num('max-events'),
    provider: values.provider,
    screen: num('screen'),
    maxVerify: num('max-verify'),
    maxSourceChecks: num('max-source-checks'),
    budgetUsd: num('budget'),
  });
  const { events, ...result } = res;
  const report: Report = { scan: result };
  const n = num('integrity-sample');
  if (n > 0) {
    const rows = await runIntegrity(sampleMarkets(events, n));
    report.integrity = { rows, summary: summarise(rows) };
  }
  console.error(`scan finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return report;
}

async function main() {
  if (values.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    return;
  }
  if (cmd === 'scan') {
    const report = await runScan();
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else console.log(toConsole(report));
    if (values.out) write(values.out, report, report);
  } else if (cmd === 'serve') {
    const { createDashboardServer } = await import('./server.ts');
    const report = existsSync(values.data!) ? (JSON.parse(readFileSync(values.data!, 'utf8')) as Report) : null;
    const server = createDashboardServer({
      report,
      runScan: async ({ maxEvents, integritySample }) => {
        const res = await scan({ maxEvents, budgetUsd: 1000 });
        const { events, ...result } = res;
        const r: Report = { scan: result };
        if (integritySample > 0) {
          const rows = await runIntegrity(sampleMarkets(events, integritySample));
          r.integrity = { rows, summary: summarise(rows) };
        }
        return r;
      },
    });
    server.listen(num('port'), values.host, () => {
      const a = server.address() as { port: number };
      console.log(`pm-edge dashboard on http://${values.host}:${a.port}  (data: ${report ? values.data : 'none, use Run live scan'})`);
      console.log('no keys are held; wallets sign in the browser. Ctrl+C to stop.');
    });
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  } else if (cmd === 'build-demo') {
    const { buildDemoHtml } = await import('./demo.ts');
    const report = JSON.parse(readFileSync(values.data!, 'utf8')) as Report;
    const html = buildDemoHtml(report);
    const out = values.out ?? 'samples/demo.html';
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html);
    mkdirSync(values.site!, { recursive: true });
    writeFileSync(join(values.site!, 'index.html'), html);
    console.error(`wrote ${out} and ${values.site}/index.html (${(html.length / 1024).toFixed(0)} KB, self-contained)`);
  } else if (cmd === 'render') {
    const file = positionals[1];
    if (!file || !values.out) throw new Error('usage: pm-edge render <scan.json> --out DIR');
    const report = JSON.parse(readFileSync(file, 'utf8')) as Report;
    write(values.out, report, report);
  } else if (cmd === 'integrity') {
    const events = await new JupiterPrediction().listEvents({ maxEvents: num('max-events'), provider: values.provider });
    const rows = await runIntegrity(sampleMarkets(events, num('sample')));
    const summary = summarise(rows);
    console.table(summary);
    if (values.out) {
      mkdirSync(values.out, { recursive: true });
      writeFileSync(join(values.out, 'integrity.json'), JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 2));
    }
  } else if (cmd === 'watch') {
    const seen = new Set<string>();
    const minProfit = num('min-profit');
    for (;;) {
      try {
        const { scan: s } = await runScan();
        for (const v of s.verified) {
          const key = `${v.candidate.kind}:${v.candidate.legs.map((l) => l.marketId + l.side).join(',')}`;
          if (v.verdict === 'ARB' && (v.sized?.netProfit ?? 0) >= minProfit && !seen.has(key)) {
            seen.add(key);
            console.log(JSON.stringify({ at: s.generatedAt, event: v.candidate.eventTitle, kind: v.candidate.kind, legs: v.candidate.legs, sized: v.sized }));
          }
        }
      } catch (e) {
        console.error(`scan failed: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, num('interval') * 1000));
    }
  } else {
    console.error(`unknown command ${cmd}; try --help`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
