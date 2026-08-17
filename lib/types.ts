/** Shared shapes passed between the fetchers, the API route, and the UI. */

export type Coin = {
  id: string;
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
  volume24h: number;
  change1h: number | null;
  change24h: number | null;
  change7d: number | null;
};

export type GlobalStats = {
  totalMarketCapUsd: number;
  totalVolumeUsd: number;
  marketCapChange24h: number;
  btcDominance: number;
  ethDominance: number;
};

export type Headline = {
  title: string;
  link: string;
  publishedAt: string | null;
  source: string;
  summary: string;
};

/** Per-source outcome, surfaced to the user so failures are visible, not silent. */
export type SourceStatus = {
  name: string;
  ok: boolean;
  detail: string;
};

export type MarketContext = {
  fetchedAt: string;
  coins: Coin[];
  gainers: Coin[];
  losers: Coin[];
  global: GlobalStats | null;
  headlines: Headline[];
  sources: SourceStatus[];
};

export type ChatRole = "user" | "assistant";

export type ChatTurn = {
  role: ChatRole;
  content: string;
};

/** NDJSON frames streamed from /api/chat back to the browser. */
export type StreamFrame =
  | { type: "meta"; fetchedAt: string; sources: SourceStatus[] }
  | { type: "text"; value: string }
  | { type: "error"; message: string }
  | { type: "done" };
