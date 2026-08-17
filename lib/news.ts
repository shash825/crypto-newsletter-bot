/**
 * Headlines from public RSS feeds — no API key, no rate limit headaches.
 *
 * CoinDesk is the primary source; CoinTelegraph is the fallback if CoinDesk
 * is down or slow. The parser is a few regexes rather than an XML library:
 * these two feeds are stable RSS 2.0 and the alternative is a dependency
 * that does considerably more than we need.
 */

import { fetchText } from "./http";
import type { Headline } from "./types";

const FEEDS = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "CoinTelegraph", url: "https://cointelegraph.com/rss" },
];

/** Unwrap CDATA, decode the handful of entities RSS actually uses, strip tags. */
function clean(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(item: string, name: string): string {
  // String.raw so the `\s\S` escapes survive the template literal — a plain
  // template would collapse them to `sS`, silently matching only runs of "s".
  const match = item.match(
    new RegExp(String.raw`<${name}[^>]*>([\s\S]*?)</${name}>`, "i"),
  );
  return match ? clean(match[1]) : "";
}

function parseFeed(xml: string, source: string, limit: number): Headline[] {
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];

  return items.slice(0, limit).flatMap((item) => {
    const title = tag(item, "title");
    if (!title) return [];

    const published = tag(item, "pubDate");
    const parsed = published ? new Date(published) : null;

    return [
      {
        title,
        link: tag(item, "link"),
        publishedAt:
          parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
        source,
        summary: tag(item, "description").slice(0, 280),
      },
    ];
  });
}

/**
 * Try each feed in order and return the first that yields headlines.
 * Throws only if every feed fails, so the caller can report one clear error.
 */
export async function fetchHeadlines(limit = 12): Promise<{
  headlines: Headline[];
  source: string;
}> {
  const failures: string[] = [];

  for (const feed of FEEDS) {
    try {
      const xml = await fetchText(feed.url, { timeoutMs: 7_000, retries: 0 });
      const headlines = parseFeed(xml, feed.source, limit);
      if (headlines.length > 0) return { headlines, source: feed.source };
      failures.push(`${feed.source}: feed returned no items`);
    } catch (error) {
      failures.push(
        `${feed.source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(failures.join("; "));
}
