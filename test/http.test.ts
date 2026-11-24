import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { HttpError, fetchJson, mapLimit } from '../src/http.ts';

async function server(handler: (n: number) => [number, string]) {
  let n = 0;
  const s = createServer((_, res) => {
    const [code, body] = handler(++n);
    res.writeHead(code, { 'content-type': 'application/json' }).end(body);
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/`, hits: () => n, close: () => s.close() };
}

test('retries 5xx / 429 then succeeds', async () => {
  const s = await server((n) => (n < 3 ? [n === 1 ? 429 : 503, 'busy'] : [200, '{"ok":true}']));
  try {
    assert.deepEqual(await fetchJson(s.url, { retries: 3 }), { ok: true });
    assert.equal(s.hits(), 3);
  } finally {
    s.close();
  }
});

test('does not retry 4xx', async () => {
  const s = await server(() => [404, 'nope']);
  try {
    await assert.rejects(fetchJson(s.url, { retries: 3 }), (e) => e instanceof HttpError && e.status === 404);
    assert.equal(s.hits(), 1);
  } finally {
    s.close();
  }
});

test('mapLimit preserves order and caps concurrency', async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, x * 3));
    inFlight--;
    return x * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.equal(peak, 2);
});
