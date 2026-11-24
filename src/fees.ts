/**
 * Jupiter Prediction trading fee model.
 *
 * Jupiter documents fees as growing with size and with uncertainty, rounded UP to the cent, and publishes a
 * table (developers.jup.ag/docs/prediction -> Fees). Every row of that table is reproduced exactly by
 *     fee = ceil_to_cent(0.07 * contracts * price * (1 - price))
 * (the same shape Kalshi uses). test/fees.test.ts pins all 18 published values, so if Jupiter changes the
 * schedule the tests fail loudly instead of the scanner silently mis-pricing.
 */
export const FEE_RATE = 0.07;

export function tradingFee(contracts: number, price: number, rate = FEE_RATE): number {
  if (contracts <= 0) return 0;
  const raw = rate * contracts * price * (1 - price);
  // Guard against float noise such as 1.3125000000000002 -> 1.32 (correct) vs 0.0700000001 -> 0.08 (wrong).
  return Math.ceil(Number((raw * 100).toFixed(9))) / 100;
}
