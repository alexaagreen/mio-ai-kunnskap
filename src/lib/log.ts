import { getPool } from "./db";

export interface QueryLogEntry {
  sessionId?: string;
  userId?: string;
  question: string;
  gate: string;
  bestScore?: number;
  articleIds?: string[];
  answer?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  latencyMs?: number;
}

/** Fire-and-forget; logging must never break a response. */
export function logQuery(e: QueryLogEntry): void {
  getPool()
    .query(
      `INSERT INTO query_log (session_id, user_id, question, gate, best_score, article_ids, answer, model, input_tokens, output_tokens, cache_read_tokens, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        e.sessionId ?? null,
        e.userId ?? null,
        e.question,
        e.gate,
        e.bestScore ?? null,
        e.articleIds ?? [],
        e.answer ?? null,
        e.model ?? null,
        e.inputTokens ?? null,
        e.outputTokens ?? null,
        e.cacheReadTokens ?? null,
        e.latencyMs ?? null,
      ],
    )
    .catch((err) => console.error("query_log insert failed", err));
}
