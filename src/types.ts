/** Shared domain types. All prices are USD per contract in [0, 1]. */

export type Provider = 'polymarket' | 'kalshi' | 'bisonfi' | string;

/** One price level: price in USD (0..1) and contract quantity. */
export interface Level {
  price: number;
  qty: number;
}

/** Normalised market as served by the Jupiter Prediction API. */
export interface JupMarket {
  marketId: string;
  eventId: string;
  provider: Provider;
  title: string;
  status: string;
  closeTime: number | null; // unix seconds
  buyYes: number | null;
  sellYes: number | null;
  buyNo: number | null;
  sellNo: number | null;
  volume: number;
  conditionId: string | null;
  clobTokenIds: string[] | null;
  outcomes: string[] | null;
  /** Labels of outcomes for which buying YES in this market pays out. */
  yesLabels: string[];
}

export interface JupEvent {
  eventId: string;
  title: string;
  category: string;
  provider: Provider;
  series: string | null;
  closeTime: number | null;
  volumeUsd: number;
  markets: JupMarket[];
}

/** The YES/NO bid ladders Jupiter returns for one market. */
export interface JupOrderbook {
  yesBids: Level[];
  noBids: Level[];
}

export type SetKind =
  | 'binary-yes-no' // YES + NO of one market
  | 'condition-pair' // Polymarket binary condition split into one Jupiter market per outcome
  | 'multi-outcome-yes' // YES on every outcome of a mutually exclusive, exhaustive event (pays $1)
  | 'multi-outcome-no'; // NO on every outcome of such an event (pays $(n-1))

export interface SetLeg {
  marketId: string;
  title: string;
  side: 'yes' | 'no';
  quote: number; // Jupiter quoted buy price for this leg
}

export interface CompleteSetCandidate {
  kind: SetKind;
  eventId: string;
  eventTitle: string;
  provider: Provider;
  category: string;
  closeTime: number | null;
  legs: SetLeg[];
  /** Sum of quoted buy prices across legs (cost of one full set before fees). */
  quotedCost: number;
  /** Guaranteed payout of one full set at resolution, in USD. */
  payout: number;
}

export type Exclusivity =
  | { status: 'structural'; note: string }
  | { status: 'verified'; note: string }
  | { status: 'rejected'; note: string }
  | { status: 'unverified'; note: string };

export interface SizedOpportunity {
  contracts: number;
  grossCost: number;
  fees: number;
  netProfit: number;
  /** netProfit / (grossCost + fees) */
  roi: number;
  /** ROI annualised by time until the market closes (capital is locked until resolution). */
  apr: number | null;
  avgLegPrices: number[];
}

export interface VerifiedSet {
  candidate: CompleteSetCandidate;
  exclusivity: Exclusivity;
  /** Best-ask sum from live Jupiter orderbooks (null when a leg has no asks). */
  bookCost: number | null;
  sized: SizedOpportunity | null;
  verdict: 'ARB' | 'NO-EDGE-AFTER-FEES' | 'NO-DEPTH' | 'NOT-A-COMPLETE-SET' | 'UNVERIFIED';
  /** Ready-to-POST bodies for Jupiter `POST /prediction/v1/orders` (ARB only). Never signed or sent by this tool. */
  orders?: OrderRequest[];
}

export interface OrderRequest {
  ownerPubkey: string;
  marketId: string;
  isYes: boolean;
  isBuy: true;
  contracts: string;
  /** USDC native units (6 decimals), covering the leg's cost plus its fee. */
  depositAmount: string;
  depositMint: string;
}

export interface IntegrityRow {
  marketId: string;
  provider: Provider;
  title: string;
  jupBuyYes: number | null;
  jupSellYes: number | null;
  venueAsk: number | null;
  venueBid: number | null;
  /** Jupiter buy price minus native venue best ask, in cents (positive = Jupiter is dearer). */
  buyDiffCents: number | null;
  /** Native venue best bid minus Jupiter sell price, in cents (positive = Jupiter pays less). */
  sellDiffCents: number | null;
  error?: string;
}
