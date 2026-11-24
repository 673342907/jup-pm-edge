/**
 * Pre-sign safety review. NO imports: the browser loads this exact file, and the server runs the same rules
 * against its own scan data so a tampered client cannot talk the server into building a trap order.
 *
 * Hard rules:
 *  - Rejected trap baskets (not a complete set) can NEVER be built for signing. In dry-run they can be inspected
 *    as a payload preview only, after an explicit acknowledgement.
 *  - UNVERIFIED and NO-DEPTH baskets can never be signed.
 *  - Every leg must meet Jupiter's $5 minimum; stake must be within the hard cap.
 *  - Negative-edge baskets need an explicit acknowledgement before a live signature.
 *  - Before signing, the unsigned transaction's fee payer and required signers must be the connected wallet.
 */

export type Mode = 'dry-run' | 'live';
export type CheckStatus = 'pass' | 'warn' | 'block';

export interface ReviewInput {
  mode: Mode;
  ownerPubkey: string;
  verdict: string; // ARB | NO-EDGE-AFTER-FEES | NO-DEPTH | NOT-A-COMPLETE-SET | UNVERIFIED
  exclusivityStatus: string; // structural | verified | rejected | unverified
  exclusivityNote: string;
  stakeUsd: number;
  maxStakeUsd?: number;
  minOrderUsd?: number;
  /** Fresh stake quote; null when the books cannot fill it. */
  quote: { netProfit: number; totalCost: number; fees: number; legs: { deposit: number }[]; depthLimited: boolean } | null;
  acknowledgeTrap?: boolean;
  acknowledgeLoss?: boolean;
}

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface Review {
  mode: Mode;
  /** Real unsigned transactions may be requested from Jupiter. */
  canBuildUnsigned: boolean;
  /** Only the request bodies may be shown (trap / unverified inspection in dry-run). */
  previewOnly: boolean;
  /** A wallet signature may be requested. Only ever true in live mode. */
  canSign: boolean;
  checks: Check[];
  blockers: string[];
  warnings: string[];
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array | null {
  if (!s || /[^1-9A-HJ-NP-Za-km-z]/.test(s)) return null;
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(ALPHABET.indexOf(ch));
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/** A Solana public key is 32 bytes, base58-encoded. */
export function isValidPubkey(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  return base58Decode(s)?.length === 32;
}

export function reviewExecution(i: ReviewInput): Review {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });
  const maxStake = i.maxStakeUsd ?? 1_000;
  const minOrder = i.minOrderUsd ?? 5;
  const trap = i.verdict === 'NOT-A-COMPLETE-SET' || i.exclusivityStatus === 'rejected';
  const unverified = i.verdict === 'UNVERIFIED' || i.exclusivityStatus === 'unverified';
  let previewOnly = false;

  add('wallet', isValidPubkey(i.ownerPubkey) ? 'pass' : 'block', isValidPubkey(i.ownerPubkey) ? `owner ${i.ownerPubkey}` : 'connect a wallet or enter a valid Solana public key');

  if (trap) {
    if (i.mode === 'dry-run' && i.acknowledgeTrap) {
      previewOnly = true;
      add('complete-set', 'warn', `TRAP inspected in dry-run only: ${i.exclusivityNote}. Payload preview, never buildable or signable.`);
    } else {
      add('complete-set', 'block', `TRAP: not a complete set: ${i.exclusivityNote}. Execution is hard-blocked${i.mode === 'dry-run' ? ' (tick "inspect trap" to preview the payload)' : ''}.`);
    }
  } else if (unverified) {
    if (i.mode === 'dry-run') {
      previewOnly = true;
      add('complete-set', 'warn', `UNVERIFIED: ${i.exclusivityNote}. Payload preview only.`);
    } else add('complete-set', 'block', `UNVERIFIED: ${i.exclusivityNote}. Cannot be signed.`);
  } else {
    add('complete-set', 'pass', i.exclusivityNote || 'complete set');
  }

  if (!(i.stakeUsd > 0) || i.stakeUsd > maxStake) add('stake', 'block', `stake must be between $0 and the $${maxStake} hard cap`);
  else add('stake', 'pass', `max spend $${i.stakeUsd.toFixed(2)} (USDC, incl. fees)`);

  if (!i.quote) {
    add('depth', 'block', 'live order books cannot fill this basket (no asks on at least one leg)');
  } else {
    const small = i.quote.legs.map((l, k) => (l.deposit < minOrder ? k + 1 : 0)).filter(Boolean);
    add('min-order', small.length ? 'block' : 'pass', small.length ? `leg(s) ${small.join(', ')} below Jupiter's $${minOrder} minimum: raise the stake` : `every leg ≥ $${minOrder}`);
    if (i.quote.totalCost > i.stakeUsd + 1e-6) add('max-cost', 'block', `quoted cost $${i.quote.totalCost.toFixed(2)} exceeds stake`);
    else add('max-cost', 'pass', `total $${i.quote.totalCost.toFixed(2)} = cost $${(i.quote.totalCost - i.quote.fees).toFixed(2)} + Jupiter fees $${i.quote.fees.toFixed(2)}`);
    if (trap) {
      add('edge', 'warn', `the "+$${i.quote.netProfit.toFixed(2)}" a naive sum-of-prices bot sees is illusory: payout is NOT guaranteed, worst case -$${i.quote.totalCost.toFixed(2)}`);
    } else if (i.quote.netProfit <= 0) {
      const st: CheckStatus = i.mode === 'live' && !i.acknowledgeLoss ? 'block' : 'warn';
      add('edge', st, `net $${i.quote.netProfit.toFixed(2)} after fees: this basket LOSES money${st === 'block' ? ' (acknowledge to sign anyway)' : ''}`);
    } else add('edge', 'pass', `net +$${i.quote.netProfit.toFixed(2)} at resolution`);
    if (i.quote.depthLimited) add('depth', 'warn', 'order-book depth, not your stake, limits the size');
  }

  const warnings = [
    'Each leg is a separate transaction. If a later leg fails or fills worse, you hold a partial, directional position.',
    'Prices can move between this quote and the keeper fill. The deposit caps your spend, not the fill price.',
    'Capital is locked until the markets resolve. A complete set pays at resolution, not now.',
  ];
  const blockers = checks.filter((c) => c.status === 'block').map((c) => `${c.name}: ${c.detail}`);
  const ok = blockers.length === 0;
  return {
    mode: i.mode,
    canBuildUnsigned: ok && !previewOnly,
    previewOnly: ok && previewOnly,
    canSign: ok && !previewOnly && i.mode === 'live',
    checks,
    blockers,
    warnings: [...checks.filter((c) => c.status === 'warn').map((c) => `${c.name}: ${c.detail}`), ...warnings],
  };
}

export interface TxInspection {
  version: 'legacy' | 0;
  signatures: number;
  requiredSigners: string[];
  feePayer: string;
  accountKeys: number;
}

function compactU16(b: Uint8Array, o: number): [number, number] {
  let v = 0;
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const x = b[o + k]!;
    v |= (x & 0x7f) << s;
    if (!(x & 0x80)) return [v, k + 1];
    s += 7;
  }
  return [v, 3];
}

/** Decode the header of a serialized Solana transaction (legacy or v0) without any SDK. */
export function inspectTransaction(bytes: Uint8Array): TxInspection {
  let o = 0;
  const [nsig, a] = compactU16(bytes, o);
  o += a + nsig * 64;
  if (nsig < 1 || o + 4 > bytes.length) throw new Error('truncated transaction');
  let version: 'legacy' | 0 = 'legacy';
  if (bytes[o]! & 0x80) {
    version = 0;
    o += 1;
  }
  const numRequired = bytes[o]!;
  o += 3;
  const [nkeys, b] = compactU16(bytes, o);
  o += b;
  if (nkeys < 1 || numRequired < 1 || numRequired > nkeys) throw new Error('invalid message header');
  if (o + nkeys * 32 > bytes.length) throw new Error('truncated transaction');
  const keys: string[] = [];
  for (let k = 0; k < nkeys; k++) keys.push(base58Encode(bytes.slice(o + k * 32, o + (k + 1) * 32)));
  return { version, signatures: nsig, requiredSigners: keys.slice(0, numRequired), feePayer: keys[0]!, accountKeys: nkeys };
}

/** The last gate before a wallet prompt: the transaction must be paid for and signed by the connected wallet only. */
export function checkUnsignedTx(bytes: Uint8Array, ownerPubkey: string): Check {
  try {
    const t = inspectTransaction(bytes);
    if (t.feePayer !== ownerPubkey) return { name: 'tx-signer', status: 'block', detail: `fee payer ${t.feePayer} is not your wallet` };
    const others = t.requiredSigners.filter((s) => s !== ownerPubkey);
    if (others.length) return { name: 'tx-signer', status: 'warn', detail: `also requires ${others.length} other signer(s): ${others.join(', ')}` };
    return { name: 'tx-signer', status: 'pass', detail: `v${t.version === 0 ? '0' : 'legacy'} tx, fee payer and sole signer = your wallet, ${t.accountKeys} accounts` };
  } catch (e) {
    return { name: 'tx-signer', status: 'block', detail: `cannot decode transaction: ${(e as Error).message}` };
  }
}
