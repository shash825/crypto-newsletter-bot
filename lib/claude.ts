/**
 * The single Claude call, shared by both request modes.
 *
 * Sonnet 5 runs adaptive thinking by default. This app disables it: the
 * grounding work is done by the fetchers, so the model is summarizing data
 * it has already been handed, and disabling thinking makes the first token
 * arrive noticeably sooner in a chat UI. Flip THINKING to `adaptive` below
 * if you want deeper reasoning at the cost of a pause before output.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ThinkingConfigParam } from "@anthropic-ai/sdk/resources/messages";
import { MODEL } from "./prompts";
import type { ChatTurn } from "./types";

const THINKING: ThinkingConfigParam = { type: "disabled" };

/** How many prior turns to replay. Keeps the request small and predictable. */
const MAX_HISTORY_TURNS = 10;

let client: Anthropic | null = null;

/** Lazily constructed so a missing key surfaces as a clean 500, not a crash at import. */
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local locally, or to the project's environment variables in Vercel.",
    );
  }
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

type StreamArgs = {
  system: string;
  history: ChatTurn[];
  message: string;
  effort: "low" | "medium" | "high";
  maxTokens: number;
};

/** Opens a streaming Messages request and yields text deltas as they arrive. */
export async function* streamClaude(args: StreamArgs): AsyncGenerator<string> {
  const messages = [
    ...args.history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: "user" as const, content: args.message },
  ];

  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: args.maxTokens,
    system: args.system,
    thinking: THINKING,
    output_config: { effort: args.effort },
    messages,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    yield "\n\n_(Claude declined to answer this one.)_";
  }
}
