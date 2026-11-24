import { readFileSync } from 'node:fs';
import type { Fetcher, HttpOptions } from '../src/http.ts';
import { base58Decode } from '../src/safety.ts';

export const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** A Fetcher that serves canned responses by URL substring, and records every call. */
export function routeFetcher(routes: Record<string, unknown | ((url: string, opts?: HttpOptions) => unknown)>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, opts) => {
    calls.push(`${opts?.method ?? 'GET'} ${url}`);
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return typeof v === 'function' ? (v as (u: string, o?: HttpOptions) => unknown)(url, opts) : structuredClone(v);
    throw new Error(`no route for ${url}`);
  };
  return { fetcher, calls };
}

/** Serialize a minimal v0 Solana transaction whose first account (fee payer) is `owner`. Header-accurate for tests. */
export function fakeV0Tx(owner: string, extraSigners: string[] = [], readonlyKeys = 2): string {
  const keys = [owner, ...extraSigners].map((k) => base58Decode(k)!);
  for (let i = 0; i < readonlyKeys; i++) keys.push(new Uint8Array(32).fill(i + 7));
  const parts: number[] = [1 + extraSigners.length, ...new Array(64 * (1 + extraSigners.length)).fill(0), 0x80, 1 + extraSigners.length, 0, readonlyKeys, keys.length];
  for (const k of keys) parts.push(...k);
  parts.push(...new Array(32).fill(9), 0, 0); // recent blockhash, 0 instructions, 0 lookups
  return Buffer.from(parts).toString('base64');
}

export const OWNER = '4DRp7Jqivcmt3KGqGuoYSikzTZDGXUXLhD4VhL4iL78G';
export const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
