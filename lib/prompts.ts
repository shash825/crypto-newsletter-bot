/**
 * Turns fetched data into the text Claude actually reads, plus the two
 * system prompts (conversational answers and newsletter digests).
 */

import type { Coin, MarketContext } from "./types";

export const MODEL = "claude-sonnet-5";

function usd(value: number): string {
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(2)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1) return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${value.toPrecision(4)}`;
}

function pct(value: number | null): string {
  if (value === null) return "n/a";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function coinLine(coin: Coin): string {
  return [
    `${coin.symbol} (${coin.name})`,
    `price ${usd(coin.price)}`,
    `1h ${pct(coin.change1h)}`,
    `24h ${pct(coin.change24h)}`,
    `7d ${pct(coin.change7d)}`,
    `mcap ${usd(coin.marketCap)}`,
    `vol24h ${usd(coin.volume24h)}`,
  ].join(" | ");
}

/** The single data block appended to the user's turn on every request. */
export function renderContext(context: MarketContext, coinLimit = 25): string {
  const parts: string[] = [
    `DATA SNAPSHOT (fetched ${context.fetchedAt}, all figures USD)`,
  ];

  if (context.global) {
    const g = context.global;
    parts.push(
      [
        "## Global market",
        `Total market cap: ${usd(g.totalMarketCapUsd)} (${pct(g.marketCapChange24h)} 24h)`,
        `24h volume: ${usd(g.totalVolumeUsd)}`,
        `BTC dominance: ${g.btcDominance.toFixed(1)}% | ETH dominance: ${g.ethDominance.toFixed(1)}%`,
      ].join("\n"),
    );
  }

  if (context.coins.length > 0) {
    parts.push(
      `## Top coins by market cap\n${context.coins
        .slice(0, coinLimit)
        .map(coinLine)
        .join("\n")}`,
    );
  }

  if (context.gainers.length > 0) {
    parts.push(`## Biggest 24h gainers\n${context.gainers.map(coinLine).join("\n")}`);
  }

  if (context.losers.length > 0) {
    parts.push(`## Biggest 24h losers\n${context.losers.map(coinLine).join("\n")}`);
  }

  if (context.headlines.length > 0) {
    parts.push(
      `## Recent headlines\n${context.headlines
        .map((h, i) => {
          const when = h.publishedAt
            ? new Date(h.publishedAt).toUTCString()
            : "date unknown";
          return `${i + 1}. [${h.source}, ${when}] ${h.title}\n   ${h.summary}\n   ${h.link}`;
        })
        .join("\n")}`,
    );
  }

  const failed = context.sources.filter((s) => !s.ok);
  if (failed.length > 0) {
    parts.push(
      `## Unavailable sources\n${failed
        .map((s) => `- ${s.name}: ${s.detail}`)
        .join("\n")}\nSay plainly which figures you could not retrieve rather than estimating them.`,
    );
  }

  return parts.join("\n\n");
}

const GROUNDING = `The DATA SNAPSHOT below is the only source of current prices, moves, and news. Your training data is months stale — never quote a price, percentage, or recent event from memory, and never fill a gap the snapshot leaves empty. If the snapshot does not cover something, say so in one sentence and answer with what it does cover.

Cite figures exactly as given. When you reference a headline, name its outlet. You are not a licensed financial advisor: describe what the data shows and why it might matter, and do not tell the reader what to buy, sell, or hold.`;

export const CHAT_SYSTEM = `You are a crypto market analyst answering questions in a chat interface.

${GROUNDING}

Lead with the answer, then the supporting numbers. Match the response to the question: a price check is one or two sentences, a "what's going on with X" needs a short paragraph tying the price action to any relevant headline. Use markdown sparingly — bold for figures, a short list only when you are genuinely enumerating. No headers on a short answer, and no preamble about what you are about to do.`;

export const NEWSLETTER_SYSTEM = `You are writing a daily crypto newsletter digest.

${GROUNDING}

Produce exactly this structure in markdown:

# <a specific headline capturing the day's single biggest story — never a generic label like "Crypto Market Update">

<One-sentence standfirst framing the day.>

## Stories
3-5 bullets. Each opens with a bolded 2-5 word label, then one or two sentences on what happened and why it matters. Ground every bullet in a headline or a price move from the snapshot, and name the outlet for anything drawn from the news.

## Market snapshot
Total market cap with its 24h change, BTC and ETH prices with 24h moves, BTC dominance, then the biggest gainer and loser with their percentages. Prose with bolded figures, not a table.

## Watching
One or two sentences on what a reader should keep an eye on next, drawn from the data — not a prediction and not advice.

Keep the whole digest under 400 words. Write like a market newsletter someone reads over coffee: specific, plain, no hype and no filler.`;

export const NEWSLETTER_REQUEST =
  "Write today's newsletter digest from the snapshot below.";
