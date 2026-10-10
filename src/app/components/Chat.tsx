"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Role = "user" | "assistant";

interface Source {
  id: string;
  articleNumber: string | null;
  title: string;
  sourceUrl: string | null;
}

interface Message {
  id: string;
  role: Role;
  content: string;
  gate?: string;
  sources?: Source[];
  latencyMs?: number;
  streaming?: boolean;
}

type ChatEvent =
  | { type: "meta"; gate: string; sources: Source[] }
  | { type: "text"; delta: string }
  | { type: "done"; latencyMs: number }
  | { type: "error"; message: string };

const GATE_LABEL: Record<string, string> = {
  cached: "Fra tidligere svar",
  gate1_too_short: "For kort spørsmål",
  gate1_too_long: "For langt spørsmål",
  gate2_no_match: "Ikke funnet i kunnskapsbasen",
  gate3_out_of_scope: "Utenfor kunnskapsbasen",
  gate3_clarify: "Trenger presisering",
};

const SUGGESTIONS = ["Hvordan registrerer jeg en ny bruker?", "Hva er rutinen for refusjon?", "Hvem godkjenner reiseregninger?"];

function uid() {
  return Math.random().toString(36).slice(2);
}

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const sessionId = useRef(uid());
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setInput("");

    const userMsg: Message = { id: uid(), role: "user", content: question };
    const assistantId = uid();
    const history = [...messages, userMsg];
    setMessages([...history, { id: assistantId, role: "assistant", content: "", streaming: true }]);
    setBusy(true);

    const patch = (p: Partial<Message>) => setMessages((ms) => ms.map((m) => (m.id === assistantId ? { ...m, ...p } : m)));

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.map(({ role, content }) => ({ role, content })), sessionId: sessionId.current }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as ChatEvent;
          if (ev.type === "meta") patch({ gate: ev.gate, sources: ev.sources });
          else if (ev.type === "text") {
            content += ev.delta;
            patch({ content });
          } else if (ev.type === "done") patch({ latencyMs: ev.latencyMs, streaming: false });
          else if (ev.type === "error") patch({ content: content || ev.message, gate: "error", streaming: false });
        }
      }
      patch({ streaming: false });
    } catch (err) {
      if ((err as Error).name !== "AbortError") patch({ content: "Klarte ikke å hente svar. Prøv igjen.", gate: "error", streaming: false });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <section className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <p>Still et spørsmål, for eksempel:</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => send(s)} type="button">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <article key={m.id} className={`bubble ${m.role}`}>
            {m.gate && m.gate !== "answered" && <span className={`badge ${m.gate === "error" ? "bad" : ""}`}>{GATE_LABEL[m.gate] ?? m.gate}</span>}
            <div className="content">
              {m.content ? (
                m.role === "assistant" ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                ) : (
                  m.content
                )
              ) : m.streaming ? (
                <span className="dots">Tenker…</span>
              ) : null}
            </div>
            {m.sources && m.sources.length > 0 && m.gate === "answered" && (
              <div className="sources">
                {m.sources.map((s) =>
                  s.sourceUrl ? (
                    <a key={s.id} href={s.sourceUrl} target="_blank" rel="noreferrer" className="source">
                      {s.articleNumber ? `[${s.articleNumber}] ` : ""}
                      {s.title}
                    </a>
                  ) : (
                    <span key={s.id} className="source">
                      {s.articleNumber ? `[${s.articleNumber}] ` : ""}
                      {s.title}
                    </span>
                  ),
                )}
              </div>
            )}
          </article>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder="Skriv spørsmålet ditt…"
          rows={2}
          maxLength={1000}
          disabled={busy}
        />
        <div className="composer-actions">
          <span className="muted small">{input.length}/1000</span>
          {busy ? (
            <button type="button" className="secondary" onClick={() => abortRef.current?.abort()}>
              Stopp
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
