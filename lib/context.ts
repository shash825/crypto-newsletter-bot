/**
 * Gathers everything Claude sees for a single request.
 *
 * Every source is settled independently: if prices are down we still answer
 * from headlines, and vice versa. The per-source outcome travels back to the
 * UI so a degraded answer is visibly degraded rather than quietly wrong.
 */

import { fetchGlobalStats, fetchMentionedCoins, fetchTopMarkets, topMovers } from "./coingecko";
import { fetchHeadlines } from "./news";
import type { Coin, MarketContext, SourceStatus } from "./types";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function gatherContext(userMessage: string): Promise<MarketContext> {
  const sources: SourceStatus[] = [];

  const [marketsResult, globalResult, newsResult] = await Promise.allSettled([
    fetchTopMarkets(50),
    fetchGlobalStats(),
    fetchHeadlines(12),
  ]);

  let coins: Coin[] = [];
  if (marketsResult.status === "fulfilled") {
    coins = marketsResult.value;
    sources.push({
      name: "CoinGecko markets",
      ok: true,
      detail: `${coins.length} coins`,
    });
  } else {
    sources.push({
      name: "CoinGecko markets",
      ok: false,
      detail: describe(marketsResult.reason),
    });
  }

  const global = globalResult.status === "fulfilled" ? globalResult.value : null;
  sources.push({
    name: "CoinGecko global",
    ok: globalResult.status === "fulfilled",
    detail:
      globalResult.status === "fulfilled"
        ? "market cap + dominance"
        : describe(globalResult.reason),
  });

  const headlines = newsResult.status === "fulfilled" ? newsResult.value.headlines : [];
  sources.push({
    name: "News RSS",
    ok: newsResult.status === "fulfilled",
    detail:
      newsResult.status === "fulfilled"
        ? `${headlines.length} from ${newsResult.value.source}`
        : describe(newsResult.reason),
  });

  // Optional enrichment for coins outside the top 50. Never fails the request.
  if (coins.length > 0 && userMessage.trim()) {
    try {
      const extra = await fetchMentionedCoins(userMessage, coins);
      if (extra.length > 0) {
        coins = [...coins, ...extra];
        sources.push({
          name: "CoinGecko lookup",
          ok: true,
          detail: extra.map((c) => c.symbol).join(", "),
        });
      }
    } catch {
      // Enrichment is a bonus; the top-50 slice already covers most questions.
    }
  }

  const { gainers, losers } = topMovers(coins);

  return {
    fetchedAt: new Date().toISOString(),
    coins,
    gainers,
    losers,
    global,
    headlines,
    sources,
  };
}

/** True when every source failed and there is nothing to ground an answer in. */
export function isContextEmpty(context: MarketContext): boolean {
  return context.coins.length === 0 && context.headlines.length === 0;
}
