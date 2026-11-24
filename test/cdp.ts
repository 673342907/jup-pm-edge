/** Minimal Chrome DevTools Protocol driver (no deps): headless Chrome, open a page, wait for DOM, screenshot. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Browser { open(url: string, opts?: { width?: number; height?: number; init?: string }): Promise<Page>; close(): Promise<void> }
export interface Page {
  eval<T = unknown>(expr: string): Promise<T>;
  waitFor(expr: string, timeoutMs?: number): Promise<void>;
  screenshot(path: string, fullPage?: boolean): Promise<void>;
  close(): Promise<void>;
}

export async function launch(chrome = process.env.CHROME ?? '/usr/bin/google-chrome'): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), 'pm-edge-cdp-'));
  const proc: ChildProcess = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { /* not yet */ }
  }
  if (!port) { proc.kill('SIGKILL'); throw new Error('chrome did not start'); }
  const http = `http://127.0.0.1:${port}`;
  return {
    async open(url, { width = 1440, height = 1000, init }: { width?: number; height?: number; init?: string } = {}) {
      const t = (await (await fetch(`${http}/json/new?about:blank`, { method: 'PUT' })).json()) as { id: string; webSocketDebuggerUrl: string };
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      let id = 0;
      const pending = new Map<number, (m: any) => void>();
      const dialogs: string[] = [];
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
        // never leave a page stuck on alert()/confirm(); confirms are DECLINED so nothing live can proceed
        if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: m.params.type === 'alert' } })); }
      };
      const send = (method: string, params: object = {}) => new Promise<any>((res, rej) => {
        const n = ++id;
        pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
        ws.send(JSON.stringify({ id: n, method, params }));
      });
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await send('Page.enable');
      if (init) await send('Page.addScriptToEvaluateOnNewDocument', { source: init });
      await send('Page.navigate', { url });
      const page: Page & { dialogs: string[] } = {
        dialogs,
        async eval(expr) {
          const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value;
        },
        async waitFor(expr, timeoutMs = 30_000) {
          const end = Date.now() + timeoutMs;
          for (;;) {
            try { if (await page.eval(`!!(${expr})`)) return; } catch { /* page still loading */ }
            if (Date.now() > end) throw new Error(`timeout waiting for ${expr}`);
            await new Promise((r) => setTimeout(r, 200));
          }
        },
        async screenshot(path, fullPage = false) {
          let clip;
          if (fullPage) {
            const h = await page.eval<number>('Math.min(document.documentElement.scrollHeight, 4000)');
            clip = { x: 0, y: 0, width, height: h, scale: 1 };
            await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false });
          }
          const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!fullPage, ...(clip ? { clip } : {}) });
          writeFileSync(path, Buffer.from(r.data, 'base64'));
        },
        async close() { ws.close(); await fetch(`${http}/json/close/${t.id}`).catch(() => {}); },
      };
      return page;
    },
    async close() {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (proc.exitCode == null) proc.kill('SIGKILL');
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
