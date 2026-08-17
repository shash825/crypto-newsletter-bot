"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SourceStatus, StreamFrame } from "@/lib/types";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: SourceStatus[];
  fetchedAt?: string;
  error?: string;
  streaming?: boolean;
};

const SUGGESTIONS = [
  "What's happening with ETH this week?",
  "Which top-50 coins moved most in the last 24h?",
  "Is Bitcoin dominance rising or falling?",
  "Summarize today's biggest crypto story",
];

function newId() {
  return Math.random().toString(36).slice(2);
}

/** Reads the NDJSON body, invoking `onFrame` for each complete line. */
async function readFrames(
  response: Response,
  onFrame: (frame: StreamFrame) => void,
) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The server returned an empty response.");

  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onFrame(JSON.parse(line) as StreamFrame);
      newline = buffer.indexOf("\n");
    }
  }

  const tail = buffer.trim();
  if (tail) onFrame(JSON.parse(tail) as StreamFrame);
}

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const run = useCallback(
    async (mode: "chat" | "newsletter", text: string) => {
      if (busy) return;
      setBusy(true);

      const history = messages
        .filter((m) => !m.error && m.content)
        .map((m) => ({ role: m.role, content: m.content }));

      const userMessage: Message | null =
        mode === "chat" ? { id: newId(), role: "user", content: text } : null;

      const replyId = newId();
      const reply: Message = {
        id: replyId,
        role: "assistant",
        content: "",
        streaming: true,
      };

      setMessages((prev) => [...prev, ...(userMessage ? [userMessage] : []), reply]);
      setInput("");

      const patch = (update: Partial<Message>) =>
        setMessages((prev) =>
          prev.map((m) => (m.id === replyId ? { ...m, ...update } : m)),
        );

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, message: text, history }),
        });

        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(detail?.error ?? `Request failed (${response.status}).`);
        }

        let buffered = "";
        await readFrames(response, (frame) => {
          switch (frame.type) {
            case "meta":
              patch({ sources: frame.sources, fetchedAt: frame.fetchedAt });
              break;
            case "text":
              buffered += frame.value;
              patch({ content: buffered });
              break;
            case "error":
              patch({ error: frame.message });
              break;
            case "done":
              patch({ streaming: false });
              break;
          }
        });
        patch({ streaming: false });
      } catch (error) {
        patch({
          streaming: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, messages],
  );

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const text = input.trim();
    if (text) void run("chat", text);
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-md bg-accent/15 text-accent">
            <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
              <path
                d="M3 17.5 8.5 11l4 4L21 6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div>
            <h1 className="text-sm leading-tight font-semibold tracking-tight">
              Crypto Desk
            </h1>
            <p className="text-[11px] leading-tight text-faint">
              Live CoinGecko prices + CoinDesk headlines
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => void run("newsletter", "")}
          disabled={busy}
          className="ml-auto rounded-md border border-accent-dim/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate Newsletter
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          {messages.length === 0 ? (
            <EmptyState onPick={(text) => void run("chat", text)} disabled={busy} />
          ) : (
            <div className="flex flex-col gap-6">
              {messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-canvas px-4 pb-4 pt-3 sm:px-6">
        <form onSubmit={submit} className="mx-auto flex w-full max-w-3xl gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) submit(event);
            }}
            placeholder="Ask about a coin, a move, or today's news…"
            disabled={busy}
            className="max-h-40 min-h-[2.6rem] flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2.5 text-sm placeholder:text-faint focus:border-accent-dim/60 focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="self-end rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-canvas transition hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-30"
          >
            {busy ? "…" : "Send"}
          </button>
        </form>
        <p className="mx-auto mt-2 max-w-3xl text-[11px] text-faint">
          Answers are grounded in data fetched at request time. Informational only —
          not financial advice.
        </p>
      </div>
    </div>
  );
}

function EmptyState({
  onPick,
  disabled,
}: {
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="py-10">
      <h2 className="text-xl font-semibold tracking-tight">
        Ask about the market, grounded in live data.
      </h2>
      <p className="mt-2 max-w-lg text-sm text-muted">
        Every question triggers a fresh pull of prices and headlines before the model
        answers, so nothing comes from stale training knowledge.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            disabled={disabled}
            className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs text-muted transition hover:border-accent-dim/50 hover:text-ink disabled:opacity-40"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-surface-2 px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.content}
        </p>
      </div>
    );
  }

  const waiting = message.streaming && !message.content && !message.error;

  return (
    <div className="flex flex-col gap-2">
      {waiting ? (
        <p className="text-sm text-faint">
          Fetching live prices and headlines
          <span className="caret">…</span>
        </p>
      ) : null}

      {message.content ? (
        <div className="prose-answer text-sm text-ink">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          {message.streaming ? <span className="caret text-accent">▍</span> : null}
        </div>
      ) : null}

      {message.error ? (
        <p className="rounded-lg border border-down/30 bg-down/10 px-3 py-2 text-sm text-down">
          {message.error}
        </p>
      ) : null}

      {message.sources && !message.streaming ? (
        <SourceFooter sources={message.sources} fetchedAt={message.fetchedAt} />
      ) : null}
    </div>
  );
}

function SourceFooter({
  sources,
  fetchedAt,
}: {
  sources: SourceStatus[];
  fetchedAt?: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[11px] text-faint">
      {fetchedAt ? (
        <span>
          Fetched{" "}
          {new Date(fetchedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
      ) : null}
      {sources.map((source) => (
        <span
          key={source.name}
          title={source.detail}
          className={source.ok ? "text-faint" : "text-down"}
        >
          {source.ok ? "✓" : "✕"} {source.name}
        </span>
      ))}
    </div>
  );
}
