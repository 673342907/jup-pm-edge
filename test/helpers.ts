import { readFileSync } from 'node:fs';
import type { Fetcher } from '../src/http.ts';

export const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** A Fetcher that serves canned responses by URL substring, and records every call. */
export function routeFetcher(routes: Record<string, unknown | (() => unknown)>) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return typeof v === 'function' ? (v as () => unknown)() : structuredClone(v);
    throw new Error(`no route for ${url}`);
  };
  return { fetcher, calls };
}
