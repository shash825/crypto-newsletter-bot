/**
 * Small fetch wrapper shared by every upstream call.
 *
 * Free crypto APIs fail in three predictable ways: they hang, they 429, and
 * they 5xx. This handles all three so the callers can stay declarative.
 */

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRIES = 1;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

type FetchOptions = {
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch with a hard timeout, one backoff retry on 429/5xx, and typed errors. */
export async function fetchWithRetry(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    headers = {},
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
        headers: {
          // Some feeds and CDNs reject the default runtime user agent.
          "User-Agent": "crypto-newsletter-bot/1.0 (+https://vercel.com)",
          Accept: "application/json, application/xml, text/xml, */*",
          ...headers,
        },
      });

      if (response.ok) return response;

      const retryable = response.status === 429 || response.status >= 500;
      lastError = new UpstreamError(
        `${new URL(url).hostname} returned ${response.status}`,
        response.status,
      );

      if (!retryable || attempt === retries) throw lastError;
      // CoinGecko's public tier rate-limits aggressively; one slow retry is
      // usually enough to get through.
      await sleep(1_200 * (attempt + 1));
    } catch (error) {
      lastError = error;
      const isTimeout =
        error instanceof DOMException && error.name === "TimeoutError";
      if (attempt === retries) break;
      if (!isTimeout && error instanceof UpstreamError && error.status && error.status < 500 && error.status !== 429) {
        break;
      }
      await sleep(1_200 * (attempt + 1));
    }
  }

  if (lastError instanceof UpstreamError) throw lastError;
  if (lastError instanceof DOMException && lastError.name === "TimeoutError") {
    throw new UpstreamError(`${new URL(url).hostname} timed out`);
  }
  throw new UpstreamError(
    `${new URL(url).hostname} unreachable: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function fetchJson<T>(url: string, options?: FetchOptions): Promise<T> {
  const response = await fetchWithRetry(url, options);
  return (await response.json()) as T;
}

export async function fetchText(url: string, options?: FetchOptions): Promise<string> {
  const response = await fetchWithRetry(url, options);
  return await response.text();
}
