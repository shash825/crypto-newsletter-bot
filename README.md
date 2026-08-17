# Crypto Desk

A chat interface for crypto market questions, plus a one-click newsletter digest. Every answer is grounded in data fetched at request time — live prices from CoinGecko and current headlines from an RSS feed — so nothing comes out of the model's stale training knowledge.

Next.js (App Router) · one API route · Claude Sonnet 5 · no database, no cache, fully stateless.

---

## The two-minute version

**The whole backend is one file:** [`app/api/chat/route.ts`](app/api/chat/route.ts). Every request does the same three things.

```
POST /api/chat
   │
   ├─ 1. FETCH   CoinGecko markets + CoinGecko global + CoinDesk RSS
   │             (in parallel, each allowed to fail independently)
   │
   ├─ 2. RENDER  fetched data → a plain-text snapshot appended to the user's turn
   │
   └─ 3. STREAM  Claude Sonnet 5 → NDJSON → browser, token by token
```

There is no database, no cache, and no persistence layer. State lives in React for the length of a session and is gone on refresh. That is a deliberate constraint, not a missing feature: it means the answer you see was computed from data that was seconds old, and it makes the whole system one deployable unit with a single secret.

Two modes go through the same route, differing only in the system prompt and the shape of the user turn:

| Mode | Trigger | System prompt | Effort |
|---|---|---|---|
| `chat` | Typing a question | Answer conversationally, lead with the answer | `low` |
| `newsletter` | The **Generate Newsletter** button | Emit a fixed digest structure | `medium` |

---

## Grounding: how the model is kept honest

An LLM asked "what's ETH doing this week" will happily invent a number. Three things prevent that here.

**1. The data goes in the user turn, not the system prompt.** Each request appends a `DATA SNAPSHOT` block — global market cap, the top 25 coins with 1h/24h/7d moves, the biggest gainers and losers, and a dozen recent headlines with their outlets and timestamps. See `renderContext()` in [`lib/prompts.ts`](lib/prompts.ts).

**2. The system prompt forbids filling gaps.** It states plainly that training data is stale, that figures must be quoted exactly as given, and that a gap in the snapshot should be named rather than estimated. It also blocks buy/sell/hold recommendations — this is a market summarizer, not an advisor.

**3. Failures are told to the model *and* to the user.** If a source is down, the snapshot ends with an `Unavailable sources` section instructing the model to say what it couldn't retrieve. The same status list is streamed to the browser and rendered under each answer, so a degraded answer is visibly degraded.

---

## Data sources

Both are free and need no key or account, which keeps the deploy to a single secret.

| Source | Endpoint | Used for |
|---|---|---|
| CoinGecko | `/coins/markets` | Top 50 by market cap: price, 1h/24h/7d change, volume, market cap |
| CoinGecko | `/global` | Total market cap, 24h volume, BTC/ETH dominance |
| CoinDesk | `/arc/outboundfeeds/rss/` | Recent headlines (primary) |
| CoinTelegraph | `/rss` | Recent headlines (fallback) |

**Why RSS over CryptoPanic:** CryptoPanic's free tier now generally wants an auth token and rate-limits harder. RSS is unauthenticated, effectively unlimited, and stable. The cost is parsing XML — handled by a few dozen lines of regex in [`lib/news.ts`](lib/news.ts) rather than a dependency, since both feeds are ordinary RSS 2.0 and an XML library would do far more than this needs.

**One extra call, sometimes.** If a question names a ticker outside the top 50 (`PEPE`, `WIF`, `ONDO`…), `fetchMentionedCoins()` resolves it through a small symbol→id map and pulls just that coin. This is strictly best-effort — if it fails, the request continues with the top-50 slice.

---

## Error handling

Free APIs fail in three predictable ways: they hang, they 429, and they 5xx. Each is handled at a different layer.

- **`lib/http.ts`** — every upstream call gets an 8-second `AbortSignal.timeout` and one backoff retry on 429 or 5xx. Non-retryable 4xx errors fail immediately instead of burning the retry.
- **`lib/context.ts`** — sources are fetched with `Promise.allSettled`, so prices being down doesn't take news with it. Each source's outcome becomes a `SourceStatus` that travels all the way to the UI.
- **Total failure** — if *both* CoinGecko and the feeds are unreachable, the route refuses to answer rather than letting the model improvise, and says so.
- **Missing API key** — checked before any work happens, and returns a message naming the exact fix.
- **Mid-stream errors** — the NDJSON protocol carries an `error` frame, so a failure after streaming has started still surfaces in the UI instead of leaving a truncated answer.

To see the degraded path yourself, point the CoinGecko `BASE` constant at a bad host and ask a question — you'll get a news-only answer with a red ✕ next to the failed source.

---

## Rate limiting

The app is publicly linkable and every request spends real API credit, so [`lib/ratelimit.ts`](lib/ratelimit.ts) enforces two sliding windows, both checked *before* any upstream call so a rejected request costs nothing:

| Bucket | Limit | Guards against |
|---|---|---|
| Per IP | 20 requests / 15 min | One person hammering the demo |
| Global | 150 requests / hour | Total spend, however many people arrive |

A newsletter draws 2 from the bucket rather than 1, since it fans out to more data and generates more tokens. Rejections return `429` with a `Retry-After` header and a plain-English message that the UI renders inline.

**The honest caveat:** this is in-memory, because "no database" is a project constraint. On serverless that has a real consequence — each Vercel instance keeps its own counters, so with N warm instances the true ceiling is up to N × the limit, and a cold start resets to zero. That is fine for what it defends against (casual abuse, runaway cost on a demo) and inadequate for anything needing an exact limit. The exact version is the same shape backed by Redis, swapping the `Map` for `INCR`/`EXPIRE` against a shared store — roughly a twenty-line change, and the reason the bucket logic is isolated in its own module.

The sizing is deliberate: someone trying the demo sends a handful of messages and never notices a ceiling; a script hits it in seconds.

---

## Why NDJSON instead of plain text

The response needs to carry two things: the answer, and the metadata about which sources were reachable. Streaming raw text gives you the first but leaves nowhere to put the second.

So the route streams newline-delimited JSON, one frame per line:

```jsonc
{"type":"meta","fetchedAt":"2026-08-16T18:04:11.522Z","sources":[…]}  // sent before generation
{"type":"text","value":"Ethereum is "}                                // repeated, token by token
{"type":"text","value":"trading at "}
{"type":"done"}                                                        // or {"type":"error", …}
```

The client (`readFrames` in [`app/page.tsx`](app/page.tsx)) buffers on `\n` and dispatches per frame. The metadata arrives first, so the source footer can render before the answer finishes.

---

## Model configuration

`claude-sonnet-5`, configured in [`lib/claude.ts`](lib/claude.ts).

**Thinking is disabled**, which is worth being able to explain. Sonnet 5 runs adaptive thinking by default, but the reasoning work here is thin: the fetchers have already done the retrieval, so the model is summarizing data it was handed rather than deciding what to look up. Disabling thinking gets the first token to the screen noticeably sooner, which matters a lot in a chat UI. Flip the `THINKING` constant to `{ type: "adaptive" }` if you'd rather trade latency for depth.

`effort` is set per mode — `low` for chat replies, `medium` for the newsletter, where structure and prose quality matter more than speed. Sampling parameters (`temperature`, `top_p`) are not used; Sonnet 5 rejects them, and prompt instructions are the supported way to steer tone.

---

## Running locally

```bash
npm install
```

Then create `.env.local` with your key (get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)):

```bash
cp .env.example .env.local
```

```
ANTHROPIC_API_KEY=sk-ant-api03-…
```

```bash
npm run dev
```

Open <http://localhost:3000>. No other setup — the crypto APIs need no key.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit` |

---

## Deploying to Vercel

```bash
npx vercel --prod
```

Then add `ANTHROPIC_API_KEY` under **Project → Settings → Environment Variables** and redeploy. (Or import the repo at [vercel.com/new](https://vercel.com/new) and set the same variable in the import screen — no `vercel.json` needed; the framework is detected automatically.)

The route sets `maxDuration = 60`, which is within the limit on Vercel's Hobby tier.

---

## Project layout

```
app/
  api/chat/route.ts   The entire backend: fetch → prompt → stream
  page.tsx            Chat UI, NDJSON reader, markdown rendering
  layout.tsx          Root layout and metadata
  globals.css         Tailwind v4 theme tokens + markdown styles
lib/
  http.ts             Fetch with timeout, retry, and typed errors
  coingecko.ts        Prices, global stats, movers, ticker lookup
  news.ts             RSS fetch and parse, with feed fallback
  context.ts          Fans out to all sources, records per-source status
  prompts.ts          Snapshot rendering + both system prompts
  claude.ts           The streaming Claude call
  types.ts            Shared types, including the NDJSON frame union
```

---

## Deliberate non-goals

No accounts, no database, no email sending, and no chat history across sessions. Conversation history is kept in React state and replayed to the API (last 10 turns) so follow-up questions work within a session, then discarded on refresh.

---

## Limitations worth naming

- **CoinGecko's public tier rate-limits at roughly 5–15 requests/minute.** This app makes 2–3 calls per user request, which is fine for a demo but would need a caching layer or a paid key under real traffic. Removing the cache was a stated requirement here; adding one back is the first thing you'd do in production.
- **Rate limiting is per-instance, not global.** See the caveat under [Rate limiting](#rate-limiting) — it bounds cost on a demo, it is not an exact ceiling.
- **Headlines are titles and blurbs, not article bodies.** The model summarizes what the feed gives it. Deeper analysis would mean fetching and parsing article pages.
- **No test suite.** The upstream contracts (CoinGecko response shape, RSS structure) are the fragile part and would be the first thing worth pinning with recorded fixtures.

Informational only — nothing here is financial advice.
