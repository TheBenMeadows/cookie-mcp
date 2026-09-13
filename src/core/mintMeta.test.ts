import { describe, it, expect, vi, beforeEach } from "vitest";

import { PublicKey } from "@solana/web3.js";

const fetchTokens = vi.fn();
const getMultipleAccountsInfo = vi.fn();
vi.mock("./cookiescan", () => ({ fetchTokens: () => fetchTokens() }));
vi.mock("./rpc", () => ({ getConnection: () => ({ getMultipleAccountsInfo }) }));

import { decimalsFromMintAccount, resolveMintMeta, requireMintMeta } from "./mintMeta";
import { COOK_MINT, COOK_DECIMALS } from "./config";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const OMNOM = "9V6z4wiifv2BrCxd7rwBWBAaWS2dxSepWZmWjRpfQ66p";
const UNLISTED = "6H7xnYfBFeEU8S8mhrZRkFNS5vEegRqEwv7h42WbntCL";

function mintData(decimals: number, len = 82): Uint8Array {
  const d = new Uint8Array(len);
  d[44] = decimals;
  return d;
}

beforeEach(() => {
  fetchTokens.mockReset();
  getMultipleAccountsInfo.mockReset();
});

describe("decimalsFromMintAccount", () => {
  it("reads decimals at offset 44 for Token and Token-2022 mints", () => {
    expect(decimalsFromMintAccount({ owner: TOKEN, data: mintData(6) })).toBe(6);
    expect(decimalsFromMintAccount({ owner: TOKEN_2022, data: mintData(9, 300) })).toBe(9);
  });

  it("rejects accounts that are not SPL mints", () => {
    expect(decimalsFromMintAccount(null)).toBeNull();
    expect(
      decimalsFromMintAccount({ owner: "11111111111111111111111111111111", data: mintData(6) }),
    ).toBeNull();
    expect(decimalsFromMintAccount({ owner: TOKEN, data: mintData(6, 40) })).toBeNull();
  });
});

describe("resolveMintMeta", () => {
  it("fills COOK locally without touching the registry or RPC", async () => {
    const m = await resolveMintMeta([COOK_MINT]);
    expect(m.get(COOK_MINT)).toEqual({ dec: COOK_DECIMALS, sym: "COOK", priceCook: 1 });
    expect(fetchTokens).not.toHaveBeenCalled();
    expect(getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it("takes decimals from the registry when present and skips the RPC", async () => {
    fetchTokens.mockResolvedValue([
      { mint: OMNOM, metadata: { symbol: "OMNOM", decimals: 6 }, price: { native: 0.002 } },
    ]);
    const m = await resolveMintMeta([COOK_MINT, OMNOM]);
    expect(m.get(OMNOM)).toEqual({ dec: 6, sym: "OMNOM", priceCook: 0.002 });
    expect(getMultipleAccountsInfo).not.toHaveBeenCalled();
  });

  it("reads decimals on-chain for a mint the registry does not know — never defaults to 9", async () => {
    fetchTokens.mockResolvedValue([]);
    getMultipleAccountsInfo.mockResolvedValue([
      { owner: new PublicKey(TOKEN), data: Buffer.from(mintData(6)) },
    ]);
    const m = await resolveMintMeta([UNLISTED]);
    expect(m.get(UNLISTED)).toEqual({ dec: 6, sym: null, priceCook: null });
    const [pks] = getMultipleAccountsInfo.mock.calls[0];
    expect(pks.map((p: PublicKey) => p.toBase58())).toEqual([UNLISTED]);
  });

  it("reads on-chain when the registry row exists but lacks decimals, keeping the registry symbol", async () => {
    fetchTokens.mockResolvedValue([{ mint: UNLISTED, metadata: { symbol: "FLAT" } }]);
    getMultipleAccountsInfo.mockResolvedValue([
      { owner: new PublicKey(TOKEN_2022), data: Buffer.from(mintData(2)) },
    ]);
    const m = await resolveMintMeta([UNLISTED]);
    expect(m.get(UNLISTED)).toEqual({ dec: 2, sym: "FLAT", priceCook: null });
  });

  it("leaves a mint absent when it is neither in the registry nor an SPL mint on-chain", async () => {
    fetchTokens.mockResolvedValue([]);
    getMultipleAccountsInfo.mockResolvedValue([null]);
    const m = await resolveMintMeta([UNLISTED]);
    expect(m.has(UNLISTED)).toBe(false);
    expect(() => requireMintMeta(m, UNLISTED)).toThrow(/unknown mint/);
  });

  it("does not hit the RPC for a string that is not a pubkey, and refuses it", async () => {
    fetchTokens.mockResolvedValue([]);
    const m = await resolveMintMeta(["not-a-mint"]);
    expect(getMultipleAccountsInfo).not.toHaveBeenCalled();
    expect(() => requireMintMeta(m, "not-a-mint")).toThrow(/unknown mint/);
  });
});
