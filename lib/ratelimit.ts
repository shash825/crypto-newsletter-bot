/**
 * In-memory sliding-window rate limiting.
 *
 * Two independent buckets, both checked before any upstream work happens:
 *
 *   per-IP    stops one person hammering the demo
 *   global    caps total spend regardless of how many people show up
 *
 * Deliberately has no backing store. "No database" is a project constraint,
 * and on serverless that has a real consequence worth stating plainly: each
 * Vercel instance keeps its own counters, so with N warm instances the true
 * ceiling is up to N x the configured limit, and a cold start resets to zero.
 *
 * That is fine for what this defends against — casual abuse and runaway cost
 * on a portfolio demo — and inadequate for anything where the limit must be
 * exact. The exact version is the same shape backed by Redis, swapping the
 * Map for INCR/EXPIRE against a shared store.
 */

type Bucket = {
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
  /** key -> timestamps of requests still inside the window. */
  hits: Map<string, number[]>;
};

/**
 * 60 requests per 15 minutes per IP.
 *
 * Sized for a room, not one person: an office evaluating this shares a single
 * public IP, so the ceiling has to clear several people trying it at once —
 * six evaluators sending ten messages each fits. A script attempts thousands
 * a minute and still trips this immediately.
 */
const perIp: Bucket = { limit: 60, windowMs: 15 * 60_000, hits: new Map() };

/**
 * 200 requests per hour across everyone — the wallet guard, and the reason
 * the per-IP ceiling can afford to be generous. At roughly two or three cents
 * a request this bounds the worst case to a few dollars an hour even if the
 * link gets passed around.
 */
const global: Bucket = { limit: 200, windowMs: 60 * 60_000, hits: new Map() };

/** Stops a flood of unique IPs growing the map without bound. */
const MAX_TRACKED_KEYS = 10_000;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: "ip" | "global" };

function prune(bucket: Bucket, now: number) {
  for (const [key, times] of bucket.hits) {
    const live = times.filter((t) => now - t < bucket.windowMs);
    if (live.length === 0) bucket.hits.delete(key);
    else bucket.hits.set(key, live);
  }
}

/**
 * Records `cost` requests against a bucket, or reports how long to wait.
 * Nothing is recorded when the call is rejected, so a blocked caller cannot
 * push their own reset further out by retrying.
 */
function take(bucket: Bucket, key: string, cost: number, now: number) {
  if (bucket.hits.size > MAX_TRACKED_KEYS) prune(bucket, now);

  const times = (bucket.hits.get(key) ?? []).filter(
    (t) => now - t < bucket.windowMs,
  );

  if (times.length + cost > bucket.limit) {
    const oldest = times[0] ?? now;
    return {
      ok: false as const,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((bucket.windowMs - (now - oldest)) / 1000),
      ),
    };
  }

  for (let i = 0; i < cost; i++) times.push(now);
  bucket.hits.set(key, times);
  return { ok: true as const };
}

/**
 * Vercel sets x-forwarded-for; the client's address is the first entry.
 * Everything unidentifiable shares one bucket, which is the conservative
 * direction — a spoofed or missing header cannot buy extra quota.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * A newsletter fans out to more data and a longer generation, so it draws
 * more from the bucket than a chat reply.
 */
export function checkRateLimit(
  request: Request,
  mode: "chat" | "newsletter",
): RateLimitResult {
  const now = Date.now();
  const cost = mode === "newsletter" ? 2 : 1;

  const globalResult = take(global, "all", cost, now);
  if (!globalResult.ok) {
    return {
      allowed: false,
      retryAfterSeconds: globalResult.retryAfterSeconds,
      scope: "global",
    };
  }

  const ipResult = take(perIp, clientKey(request), cost, now);
  if (!ipResult.ok) {
    return {
      allowed: false,
      retryAfterSeconds: ipResult.retryAfterSeconds,
      scope: "ip",
    };
  }

  return { allowed: true };
}

/** Test hook — lets a check start from a known-empty state. */
export function resetRateLimits() {
  perIp.hits.clear();
  global.hits.clear();
}
