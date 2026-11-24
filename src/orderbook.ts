import type { Level } from './types.ts';
export { askLadder, costToBuy, parseJupOrderbook, round6 } from './pricing.ts';

export function bestBid(levels: Level[]): number | null {
  return levels.length ? Math.max(...levels.map((l) => l.price)) : null;
}
export function bestAsk(levels: Level[]): number | null {
  return levels.length ? Math.min(...levels.map((l) => l.price)) : null;
}
