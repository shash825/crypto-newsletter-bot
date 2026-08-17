/**
 * CoinGecko public API — no key, no auth. Rate limited to roughly 5-15
 * requests/minute, so we make at most three calls per user request and
 * degrade gracefully when any of them fail.
 */

import { fetchJson } from "./http";
import type { Coin, GlobalStats } from "./types";

const BASE = "https://api.coingecko.com/api/v3";

/** Symbols outside the top 50 that people still ask about by ticker. */
const EXTRA_SYMBOLS: Record<string, string> = {
  pepe: "pepe",
  bonk: "bonk",
  wif: "dogwifcoin",
  jup: "jupiter-exchange-solana",
  ena: "ethena",
  tia: "celestia",
  sei: "sei-network",
  pyth: "pyth-network",
  ondo: "ondo-finance",
  ldo: "lido-dao",
  arb: "arbitrum",
  op: "optimism",
  inj: "injective-protocol",
  rune: "thorchain",
  fet: "fetch-ai",
};

type RawMarket = {
  id: string;
  symbol: string;
  name: string;
  current_price: number | null;
  market_cap: number | null;
  total_volume: number | null;
  price_change_percentage_1h_in_currency?: number | null;
  price_change_percentage_24h_in_currency?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
};

type RawGlobal = {
  data: {
    total_market_cap: Record<string, number>;
    total_volume: Record<string, number>;
    market_cap_change_percentage_24h_usd: number;
    market_cap_percentage: Record<string, number>;
  };
};

function toCoin(raw: RawMarket): Coin {
  return {
    id: raw.id,
    symbol: raw.symbol.toUpperCase(),
    name: raw.name,
    price: raw.current_price ?? 0,
    marketCap: raw.market_cap ?? 0,
    volume24h: raw.total_volume ?? 0,
    change1h: raw.price_change_percentage_1h_in_currency ?? null,
    change24h: raw.price_change_percentage_24h_in_currency ?? null,
    change7d: raw.price_change_percentage_7d_in_currency ?? null,
  };
}

const MARKETS_QUERY =
  "vs_currency=usd&order=market_cap_desc&price_change_percentage=1h%2C24h%2C7d&sparkline=false";

/** Top coins by market cap, with 1h/24h/7d percentage moves. */
export async function fetchTopMarkets(limit = 50): Promise<Coin[]> {
  const raw = await fetchJson<RawMarket[]>(
    `${BASE}/coins/markets?${MARKETS_QUERY}&per_page=${limit}&page=1`,
  );
  return raw.map(toCoin);
}

/** Total market cap, 24h volume, and BTC/ETH dominance. */
export async function fetchGlobalStats(): Promise<GlobalStats> {
  const raw = await fetchJson<RawGlobal>(`${BASE}/global`);
  return {
    totalMarketCapUsd: raw.data.total_market_cap.usd ?? 0,
    totalVolumeUsd: raw.data.total_volume.usd ?? 0,
    marketCapChange24h: raw.data.market_cap_change_percentage_24h_usd ?? 0,
    btcDominance: raw.data.market_cap_percentage.btc ?? 0,
    ethDominance: raw.data.market_cap_percentage.eth ?? 0,
  };
}

/**
 * Look for coins the user named that aren't already in the top-50 slice.
 * Best-effort: a failure here just means slightly thinner context, so the
 * caller treats it as optional rather than letting it fail the request.
 */
export async function fetchMentionedCoins(
  message: string,
  alreadyHave: Coin[],
): Promise<Coin[]> {
  const have = new Set(alreadyHave.map((c) => c.symbol.toLowerCase()));
  const words = new Set(message.toLowerCase().match(/[a-z]{2,12}/g) ?? []);

  const ids = Object.entries(EXTRA_SYMBOLS)
    .filter(([symbol]) => words.has(symbol) && !have.has(symbol))
    .map(([, id]) => id);

  if (ids.length === 0) return [];

  const raw = await fetchJson<RawMarket[]>(
    `${BASE}/coins/markets?${MARKETS_QUERY}&ids=${ids.join(",")}`,
  );
  return raw.map(toCoin);
}

/** Biggest 24h movers, restricted to coins liquid enough to be meaningful. */
export function topMovers(coins: Coin[], count = 5) {
  const liquid = coins.filter((c) => c.change24h !== null && c.volume24h > 5_000_000);
  const sorted = [...liquid].sort((a, b) => (b.change24h ?? 0) - (a.change24h ?? 0));
  return {
    gainers: sorted.slice(0, count),
    losers: sorted.slice(-count).reverse(),
  };
}
