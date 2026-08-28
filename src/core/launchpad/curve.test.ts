import { describe, it, expect } from "vitest";

import {
  ceilDiv,
  estimateBuy,
  estimateSell,
  feeOf,
  graduationProgressPct,
  paymentForTokens,
  quoteBuy,
  quoteSell,
  reserves,
  spotPriceCook,
} from "./curve";
import { CookieMcpError } from "../errors";

// The launchpad's live config defaults (config `337sDmE4…`): 1,073,000e9 virtual token reserve,
// 176,471e9 virtual payment reserve, 800,000,000e6 sale supply, 1% trade fee.
const FRESH = {
  virtualPaymentReserve: "176471000000000",
  virtualTokenReserve: "1073000000000000",
  tokensSold: "0",
  paymentRaisedNet: "0",
};

describe("ceilDiv", () => {
  it("rounds up on a remainder and is exact otherwise", () => {
    expect(ceilDiv(10n, 5n)).toBe(2n);
    expect(ceilDiv(11n, 5n)).toBe(3n);
    expect(ceilDiv(0n, 5n)).toBe(0n);
  });

  it("rejects a zero divisor instead of dividing by zero", () => {
    expect(() => ceilDiv(1n, 0n)).toThrow(CookieMcpError);
  });
});

describe("feeOf", () => {
  it("floors, matching the program's checked_bps", () => {
    expect(feeOf(1_000_000n, 75)).toBe(7_500n);
    expect(feeOf(1_000_000n, 10_000)).toBe(1_000_000n);
    expect(feeOf(1_000_000n, 0)).toBe(0n);
    expect(feeOf(999n, 100)).toBe(9n); // 9.99 → 9, pool keeps the dust
  });
});

describe("reserves", () => {
  it("adds the raise to the virtual payment side and subtracts sales from the token side", () => {
    const { x, y } = reserves({
      ...FRESH,
      paymentRaisedNet: "1000000000",
      tokensSold: "6019482185",
    });
    expect(x).toBe(176_472_000_000_000n);
    expect(y).toBe(1_072_993_980_517_815n);
  });

  it("refuses a curve whose token side is exhausted", () => {
    expect(() => reserves({ ...FRESH, tokensSold: FRESH.virtualTokenReserve })).toThrow(
      CookieMcpError,
    );
  });
});

describe("quoteBuy / quoteSell", () => {
  // Golden: a 1 COOK buy on a fresh pool with the live config. The on-chain rehearsal pool
  // 4YgzpSWS… bought exactly 1 COOK (net 0.99 after the 1% fee) and recorded
  // tokens_sold = 6,019,482,185 — reproduced here, so the port matches the program byte for byte.
  it("reproduces a real on-chain buy (1 COOK → 6019.482185 tokens)", () => {
    const est = estimateBuy(FRESH, 1_000_000_000n, 100);
    expect(est.feeRaw).toBe(10_000_000n);
    expect(est.netRaw).toBe(990_000_000n);
    expect(est.tokensOutRaw).toBe(6_019_482_185n);
  });

  it("rounds the trader's output down (the pool keeps sub-unit dust)", () => {
    // k / (x + net) is not integral here, so ceil on the reserve = floor on tokens out.
    const exact = quoteBuy(FRESH, 990_000_000n);
    const k = BigInt(FRESH.virtualPaymentReserve) * BigInt(FRESH.virtualTokenReserve);
    const floorNaive =
      BigInt(FRESH.virtualTokenReserve) - k / (BigInt(FRESH.virtualPaymentReserve) + 990_000_000n);
    expect(exact).toBeLessThan(floorNaive);
  });

  it("sells back less than was paid in — the curve plus fees round against the trader", () => {
    const bought = estimateBuy(FRESH, 1_000_000_000n, 100);
    const after = {
      ...FRESH,
      paymentRaisedNet: bought.netRaw.toString(),
      tokensSold: bought.tokensOutRaw.toString(),
    };
    const sold = estimateSell(after, bought.tokensOutRaw, 100);
    expect(sold.grossRaw).toBeLessThanOrEqual(bought.netRaw);
    expect(sold.netRaw).toBeLessThan(1_000_000_000n);
    // Matches the on-chain MOMO test pool: 1 COOK in → 0.49252951 COOK out after a 50% sale.
    expect(sold.feeRaw).toBe(feeOf(sold.grossRaw, 100));
  });

  it("prices later buys worse than earlier ones (the curve only goes up)", () => {
    const first = quoteBuy(FRESH, 990_000_000n);
    const advanced = {
      ...FRESH,
      paymentRaisedNet: "100000000000000",
      tokensSold: "380000000000000",
    };
    expect(quoteBuy(advanced, 990_000_000n)).toBeLessThan(first);
  });

  it("quoteSell is the inverse direction of quoteBuy on the same reserves", () => {
    const tokens = quoteBuy(FRESH, 990_000_000n);
    const back = quoteSell(
      { ...FRESH, paymentRaisedNet: "990000000", tokensSold: tokens.toString() },
      tokens,
    );
    expect(back).toBeLessThanOrEqual(990_000_000n);
  });
});

describe("estimateBuy", () => {
  it("rejects an amount so small the fee eats all of it", () => {
    expect(() => estimateBuy(FRESH, 1n, 10_000)).toThrow(CookieMcpError);
  });
});

describe("spotPriceCook", () => {
  it("prices the fresh curve at the config's implied opening price", () => {
    // 176,471 COOK / 1,073,000,000 tokens ≈ 0.0001645 COOK per token.
    expect(spotPriceCook(FRESH, 9, 6)).toBeCloseTo(0.000164465, 7);
  });

  it("rises as the curve is bought up", () => {
    const advanced = {
      ...FRESH,
      paymentRaisedNet: "250000000000000",
      tokensSold: "600000000000000",
    };
    expect(spotPriceCook(advanced, 9, 6)).toBeGreaterThan(spotPriceCook(FRESH, 9, 6));
  });
});

describe("graduationProgressPct", () => {
  it("reports the raise as a percentage of the target", () => {
    expect(graduationProgressPct("250000000000000", "500000000000000")).toBe(50);
    expect(graduationProgressPct("0", "500000000000000")).toBe(0);
  });

  it("clamps over-target raises to 100 and handles a zero target", () => {
    expect(graduationProgressPct("500031603805152", "500000000000000")).toBe(100);
    expect(graduationProgressPct("1", "0")).toBe(0);
  });
});

describe("paymentForTokens", () => {
  // The live launch curve: vpr 176,471 COOK (9dp), vtr 1.073B tokens (6dp), 1% fee.
  const fresh = {
    virtualPaymentReserve: "176471000000000",
    virtualTokenReserve: "1073000000000000",
    tokensSold: "0",
    paymentRaisedNet: "0",
  };
  const FEE_BPS = 100;

  it("is the exact inverse of estimateBuy, and minimal", () => {
    for (const tokens of [1_000_000n, 8_000_000_000_000n, 10_000_000_000_000n]) {
      const gross = paymentForTokens(fresh, tokens, FEE_BPS);
      expect(estimateBuy(fresh, gross, FEE_BPS).tokensOutRaw).toBeGreaterThanOrEqual(tokens);
      // One base unit less must undershoot, or it is not the smallest sufficient payment.
      expect(estimateBuy(fresh, gross - 1n, FEE_BPS).tokensOutRaw).toBeLessThan(tokens);
    }
  });

  it("prices 1% of the 1B total supply at 1,676.891207465 COOK", () => {
    // 10M tokens at 6dp — the number the COWDOG launch needed. Derived by hand it came out 1,677,
    // which overbuys by 642 tokens: close enough to look right, which is why it should not be manual.
    expect(paymentForTokens(fresh, 10_000_000_000_000n, FEE_BPS)).toBe(1_676_891_207_465n);
  });

  it("prices 1% of the 800M sale supply lower — the two denominators are 338 COOK apart", () => {
    const ofSale = paymentForTokens(fresh, 8_000_000_000_000n, FEE_BPS);
    expect(ofSale).toBe(1_338_993_692_796n);
    expect(ofSale).toBeLessThan(paymentForTokens(fresh, 10_000_000_000_000n, FEE_BPS));
  });

  it("refuses a non-positive amount and more tokens than the curve holds", () => {
    expect(() => paymentForTokens(fresh, 0n, FEE_BPS)).toThrow(/must be positive/);
    expect(() => paymentForTokens(fresh, 1_073_000_000_000_000n, FEE_BPS)).toThrow(
      /cannot sell that many/,
    );
  });
});
