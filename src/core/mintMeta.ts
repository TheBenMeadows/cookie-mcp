// Decimals + symbol for Cookie Chain mints. The Cookiescan registry is the fast path; a mint it does
// not carry decimals for is read from the chain (the SPL mint account itself). A mint neither source
// knows is REFUSED — defaulting to 9 decimals would silently misscale every amount by 1000× for a
// 6-decimal token (COOK, most launchpad tokens).
import { PublicKey } from "@solana/web3.js";

import { COOK_MINT, COOK_DECIMALS, COOK_SYMBOL } from "./config";
import { fetchTokens } from "./cookiescan";
import { CookieMcpError } from "./errors";
import { getConnection } from "./rpc";

export interface MintMeta {
  dec: number;
  sym: string | null;
  priceCook: number | null;
}

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
// SPL Mint layout (shared by Token and Token-2022): mintAuthority COption<Pubkey> (36) + supply u64
// (8) → decimals u8 at offset 44; the base account is 82 bytes.
const MINT_DECIMALS_OFFSET = 44;
const MINT_BASE_LEN = 82;

/** Decimals from a raw mint account, or null if the account is not an SPL mint. */
export function decimalsFromMintAccount(
  acct: { owner: string; data: Uint8Array } | null | undefined,
): number | null {
  if (!acct) return null;
  if (acct.owner !== TOKEN_PROGRAM_ID && acct.owner !== TOKEN_2022_PROGRAM_ID) return null;
  if (acct.data.length < MINT_BASE_LEN) return null;
  return acct.data[MINT_DECIMALS_OFFSET];
}

async function fetchOnChainDecimals(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!mints.length) return out;
  const pks: PublicKey[] = [];
  for (const m of mints) {
    try {
      pks.push(new PublicKey(m));
    } catch {
      // not a valid pubkey → left absent → refused by requireMintMeta
    }
  }
  if (!pks.length) return out;
  const infos = await getConnection().getMultipleAccountsInfo(pks, "confirmed");
  infos.forEach((info, i) => {
    const dec = decimalsFromMintAccount(
      info ? { owner: info.owner.toBase58(), data: info.data } : null,
    );
    if (dec != null) out.set(pks[i].toBase58(), dec);
  });
  return out;
}

/**
 * Metadata for a set of Cookie Chain mints. COOK is filled locally. Registry first (also gives symbol
 * + COOK price); decimals the registry lacks are read on-chain. An unknown mint is left ABSENT.
 */
export async function resolveMintMeta(mints: string[]): Promise<Map<string, MintMeta>> {
  const out = new Map<string, MintMeta>();
  out.set(COOK_MINT, { dec: COOK_DECIMALS, sym: COOK_SYMBOL, priceCook: 1 });
  const need = [...new Set(mints)].filter((m) => m !== COOK_MINT);
  if (!need.length) return out;

  const registry = await fetchTokens();
  const missing: string[] = [];
  for (const m of need) {
    const t = registry.find((x) => x.mint === m);
    const dec = t?.metadata?.decimals;
    if (typeof dec === "number" && Number.isInteger(dec) && dec >= 0) {
      out.set(m, { dec, sym: t?.metadata?.symbol ?? null, priceCook: t?.price?.native ?? null });
    } else {
      missing.push(m);
    }
  }
  if (missing.length) {
    const onChain = await fetchOnChainDecimals(missing);
    for (const m of missing) {
      const dec = onChain.get(m);
      if (dec == null) continue;
      const t = registry.find((x) => x.mint === m);
      out.set(m, { dec, sym: t?.metadata?.symbol ?? null, priceCook: t?.price?.native ?? null });
    }
  }
  return out;
}

/** The meta of a mint, or a clear error — never a silent 9-decimal default. */
export function requireMintMeta(meta: Map<string, MintMeta>, mint: string): MintMeta {
  const m = meta.get(mint);
  if (!m) {
    throw new CookieMcpError(
      `unknown mint ${mint}`,
      "not in the Cookiescan registry and not an SPL mint on Cookie Chain — check the address",
    );
  }
  return m;
}
