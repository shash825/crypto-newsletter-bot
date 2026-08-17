/**
 * The entire backend: one route, no database, no cache.
 *
 * Per request: fetch fresh market data and headlines -> render them into a
 * text block -> pass that to Claude alongside the user's question -> stream
 * the answer back as NDJSON.
 *
 * The response is newline-delimited JSON rather than raw text so a single
 * stream can carry the answer plus the metadata about which upstream sources
 * were reachable. Frame shapes live in lib/types.ts.
 */

import { streamClaude } from "@/lib/claude";
import { gatherContext, isContextEmpty } from "@/lib/context";
import { checkRateLimit } from "@/lib/ratelimit";
import {
  CHAT_SYSTEM,
  NEWSLETTER_REQUEST,
  NEWSLETTER_SYSTEM,
  renderContext,
} from "@/lib/prompts";
import type { ChatTurn, StreamFrame } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RequestBody = {
  mode?: "chat" | "newsletter";
  message?: string;
  history?: ChatTurn[];
};

function frame(value: StreamFrame): string {
  return `${JSON.stringify(value)}\n`;
}

function isTurn(value: unknown): value is ChatTurn {
  if (typeof value !== "object" || value === null) return false;
  const turn = value as Record<string, unknown>;
  return (
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.content === "string"
  );
}

export async function POST(request: Request) {
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  const mode = body.mode === "newsletter" ? "newsletter" : "chat";
  const message = (body.message ?? "").trim();
  const history = Array.isArray(body.history) ? body.history.filter(isTurn) : [];

  if (mode === "chat" && !message) {
    return Response.json({ error: "Message is required." }, { status: 400 });
  }
  if (message.length > 2_000) {
    return Response.json({ error: "Message is too long." }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error:
          "ANTHROPIC_API_KEY is not set. Add it to .env.local locally, or to the project's environment variables in Vercel.",
      },
      { status: 500 },
    );
  }

  // Checked before any upstream call, so a rejected request costs nothing.
  const limit = checkRateLimit(request, mode);
  if (!limit.allowed) {
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return Response.json(
      {
        error:
          limit.scope === "ip"
            ? `Rate limit reached — this demo allows 60 requests per 15 minutes per visitor. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`
            : `This demo is capped at 200 requests per hour in total and has hit that ceiling. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      },
      {
        status: 429,
        headers: { "Retry-After": String(limit.retryAfterSeconds) },
      },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: StreamFrame) =>
        controller.enqueue(encoder.encode(frame(value)));

      try {
        // 1. Fetch fresh data. Individual sources may fail; the request survives.
        const context = await gatherContext(mode === "chat" ? message : "");
        send({ type: "meta", fetchedAt: context.fetchedAt, sources: context.sources });

        if (isContextEmpty(context)) {
          send({
            type: "error",
            message:
              "Both CoinGecko and the news feeds are unreachable right now, so there is no live data to ground an answer in. This usually clears within a minute or two — try again shortly.",
          });
          send({ type: "done" });
          controller.close();
          return;
        }

        // 2. Hand the snapshot to Claude as part of the user turn.
        const userMessage =
          mode === "newsletter"
            ? `${NEWSLETTER_REQUEST}\n\n${renderContext(context, 15)}`
            : `${message}\n\n${renderContext(context)}`;

        // 3. Stream the answer straight through to the client.
        const deltas = streamClaude({
          system: mode === "newsletter" ? NEWSLETTER_SYSTEM : CHAT_SYSTEM,
          history: mode === "newsletter" ? [] : history,
          message: userMessage,
          effort: mode === "newsletter" ? "medium" : "low",
          maxTokens: mode === "newsletter" ? 2_000 : 1_500,
        });

        for await (const text of deltas) {
          send({ type: "text", value: text });
        }

        send({ type: "done" });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        send({
          type: "error",
          message: detail.includes("ANTHROPIC_API_KEY")
            ? detail
            : `Something went wrong generating the response: ${detail}`,
        });
        send({ type: "done" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      // Vercel and some proxies buffer responses without this.
      "X-Accel-Buffering": "no",
    },
  });
}
