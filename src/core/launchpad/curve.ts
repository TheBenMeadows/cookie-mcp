// Pure bonding-curve math — a BigInt port of the launchpad program's `quote_buy` / `quote_sell`
// (constant product over virtual reserves) and its fee arithmetic. Kept exact (no floats) and
// rounded the same way the program rounds, so a quote here matches what the chain will do:
// the resulting reserve is rounded UP (ceil), which rounds the trader's output DOWN — the pool
// keeps every sub-unit of rounding.
//
// Reserves in play, from the pool account:
//   x = virtual_payment_reserve + payment_raised_net   (payment side, COOK base units)
//   y = virtual_token_reserve   − tokens_sold          (token side, token base units)
import { CookieMcpError } from "../errors";

const BPS_DENOMINATOR = 10_000n;

/** Ceiling division — mirrors the program's `ceil_div`, which rounds reserves in the pool's favor. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new CookieMcpError("invalid curve reserves", "the pool state looks corrupt");
  const q = a / b;
  return a % b === 0n ? q : q + 1n;
}

/** `amount × bps / 10000`, floored — the program's `checked_bps`. */
export function feeOf(amount: bigint, bps: number): bigint {
  return (amount * BigInt(Math.round(bps))) / BPS_DENOMINATOR;
}

/** The pool's live constant-product reserves. */
export interface CurveState {
  virtualPaymentReserve: string;
  virtualTokenReserve: string;
  tokensSold: string;
  paymentRaisedNet: string;
}

export interface Reserves {
  x: bigint;
  y: bigint;
}

export function reserves(pool: CurveState): Reserves {
  const x = BigInt(pool.virtualPaymentReserve) + BigInt(pool.paymentRaisedNet);
  const y = BigInt(pool.virtualTokenReserve) - BigInt(pool.tokensSold);
  if (x <= 0n || y <= 0n) {
    throw new CookieMcpError(
      "the pool has no tradeable curve reserves left",
      "the sale supply is exhausted or the pool state is invalid",
    );
  }
  return { x, y };
}

/** Token base units out for `netPayment` (payment AFTER the trade fee) — the program's `quote_buy`. */
export function quoteBuy(pool: CurveState, netPayment: bigint): bigint {
  const { x, y } = reserves(pool);
  const k = x * y;
  return y - ceilDiv(k, x + netPayment);
}

/** Gross payment out for `shares` (BEFORE the trade fee) — the program's `quote_sell`. */
export function quoteSell(pool: CurveState, shares: bigint): bigint {
  const { x, y } = reserves(pool);
  const k = x * y;
  return x - ceilDiv(k, y + shares);
}

export interface BuyEstimate {
  /** Trade fee taken off the top, in payment base units. */
  feeRaw: bigint;
  /** What actually enters the curve (payment − fee). */
  netRaw: bigint;
  /** Token base units (curve shares) the buyer receives. */
  tokensOutRaw: bigint;
}

/** Buy side: the fee comes off the payment first, then the remainder buys along the curve. */
export function estimateBuy(
  pool: CurveState,
  paymentRaw: bigint,
  tradeFeeBps: number,
): BuyEstimate {
  const feeRaw = feeOf(paymentRaw, tradeFeeBps);
  const netRaw = paymentRaw - feeRaw;
  if (netRaw <= 0n) {
    throw new CookieMcpError(
      "the buy amount is too small — the trade fee would consume all of it",
      "increase the amount",
    );
  }
  return { feeRaw, netRaw, tokensOutRaw: quoteBuy(pool, netRaw) };
}

/**
 * The payment that buys AT LEAST `tokensRaw` tokens — the inverse of `estimateBuy`, and the smallest
 * such amount.
 *
 * Exists because a launch is expressed in supply ("prebuy 1%") while the tool takes COOK, and doing
 * that conversion by hand invites the wrong denominator or a float that lands a hair short. Derived
 * from `quoteBuy` rather than approximated: out = y − ceil(k / (x + net)) ≥ T holds exactly when
 * net ≥ ceil(k / (y − T)) − x, since `ceil(v) ≤ m` and `v ≤ m` agree for integer m.
 */
export function paymentForTokens(pool: CurveState, tokensRaw: bigint, tradeFeeBps: number): bigint {
  const { x, y } = reserves(pool);
  if (tokensRaw <= 0n) {
    throw new CookieMcpError("the token amount must be positive", "ask for a non-zero share");
  }
  if (tokensRaw >= y) {
    throw new CookieMcpError(
      "the curve cannot sell that many tokens — it holds fewer than you asked for",
      "ask for a smaller share of the supply",
    );
  }
  const k = x * y;
  const netRaw = ceilDiv(k, y - tokensRaw) - x;
  const net = netRaw > 0n ? netRaw : 1n;

  // Invert the fee: net(gross) = gross − floor(gross·bps/10000), monotone but with flat steps where
  // the flooring hands the buyer a sub-unit. `ceil(net / (1 − fee))` lands near the answer but on
  // either side of it, so settle onto the true minimum from both directions — each loop runs a
  // handful of times, bounded by the fee's granularity.
  const bps = BigInt(Math.round(tradeFeeBps));
  const netOf = (g: bigint): bigint => g - feeOf(g, tradeFeeBps);
  let gross = ceilDiv(net * BPS_DENOMINATOR, BPS_DENOMINATOR - bps);
  while (netOf(gross) < net) gross += 1n;
  while (gross > 1n && netOf(gross - 1n) >= net) gross -= 1n;
  return gross;
}

export interface SellEstimate {
  /** Payment the curve gives up (before the fee). */
  grossRaw: bigint;
  feeRaw: bigint;
  /** What the seller actually receives. */
  netRaw: bigint;
}

/** Sell side: the curve pays out gross, then the fee is taken from the proceeds. */
export function estimateSell(
  pool: CurveState,
  sharesRaw: bigint,
  tradeFeeBps: number,
): SellEstimate {
  const grossRaw = quoteSell(pool, sharesRaw);
  const feeRaw = feeOf(grossRaw, tradeFeeBps);
  return { grossRaw, feeRaw, netRaw: grossRaw - feeRaw };
}

/**
 * Marginal price in COOK per whole token (x/y, scaled out of base units). This is the spot price
 * on the curve, so a real trade fills slightly worse (constant product + the trade fee).
 */
export function spotPriceCook(
  pool: CurveState,
  paymentDecimals: number,
  tokenDecimals: number,
): number {
  const { x, y } = reserves(pool);
  const payUi = Number(x) / 10 ** paymentDecimals;
  const tokUi = Number(y) / 10 ** tokenDecimals;
  return tokUi > 0 ? payUi / tokUi : 0;
}

/** How far the raise is toward graduation, 0–100 (clamped; 0 when no target is set). */
export function graduationProgressPct(paymentRaisedNet: string, graduationTarget: string): number {
  const target = BigInt(graduationTarget);
  if (target <= 0n) return 0;
  const raised = BigInt(paymentRaisedNet);
  const pct = (Number(raised) / Number(target)) * 100;
  return Math.min(100, Math.max(0, Number(pct.toFixed(4))));
}
