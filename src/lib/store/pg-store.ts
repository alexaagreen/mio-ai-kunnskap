import { getPool, toVectorLiteral } from "../db";
import type { CachedAnswer, CatalogueEntry, ChunkHit, KbStore, QueryLogEntry, StoredArticle } from "./index";

/**
 * Postgres + pgvector backend (STORE=postgres). Schema in db/schema.sql; populated by `npm run kb:ingest`.
 * Runs unchanged on Neon/Supabase (prototype) and Azure Database for PostgreSQL Flexible Server (live).
 */
export class PgStore implements KbStore {
  readonly kind = "postgres" as const;
  private categoryCache?: { at: number; value: string[] };

  async listCatalogue(): Promise<CatalogueEntry[]> {
    const res = await getPool().query<{ id: string; article_number: string | null; title: string; summary: string | null; categories: string[] }>(
      `SELECT id, article_number, title, summary, categories FROM articles ORDER BY title`,
    );
    return res.rows.map((r) => ({ id: r.id, articleNumber: r.article_number ?? undefined, title: r.title, summary: r.summary ?? undefined, categories: r.categories }));
  }

  async vectorSearch(embedding: number[], k: number): Promise<ChunkHit[]> {
    const res = await getPool().query<{ article_id: string; chunk_index: number; score: number }>(
      `SELECT article_id, chunk_index, 1 - (embedding <=> $1::vector) AS score
         FROM chunks ORDER BY embedding <=> $1::vector LIMIT $2`,
      [toVectorLiteral(embedding), k],
    );
    return res.rows.map((r) => ({ articleId: r.article_id, chunkIndex: r.chunk_index, score: Number(r.score) }));
  }

  async keywordSearch(query: string, k: number): Promise<ChunkHit[]> {
    const res = await getPool().query<{ article_id: string; chunk_index: number; score: number }>(
      `SELECT article_id, chunk_index, ts_rank_cd(tsv, q) AS score
         FROM chunks, websearch_to_tsquery('norwegian', $1) q
        WHERE tsv @@ q ORDER BY score DESC LIMIT $2`,
      [query, k],
    );
    return res.rows.map((r) => ({ articleId: r.article_id, chunkIndex: r.chunk_index, score: Number(r.score) }));
  }

  async getArticles(ids: string[]): Promise<StoredArticle[]> {
    const res = await getPool().query<{
      id: string;
      article_number: string | null;
      title: string;
      summary: string | null;
      body_md: string;
      categories: string[];
      language: string;
      version: number | null;
      last_published: Date | null;
      source_url: string | null;
      content_hash: string;
    }>(`SELECT * FROM articles WHERE id = ANY($1)`, [ids]);
    const byId = new Map<string, StoredArticle>(
      res.rows.map((a) => [
        a.id,
        {
          id: a.id,
          articleNumber: a.article_number ?? undefined,
          title: a.title,
          summary: a.summary ?? undefined,
          bodyMd: a.body_md,
          categories: a.categories,
          language: a.language,
          version: a.version ?? undefined,
          lastPublished: a.last_published?.toISOString(),
          sourceUrl: a.source_url ?? undefined,
          contentHash: a.content_hash,
        },
      ]),
    );
    return ids.map((id) => byId.get(id)).filter((a): a is StoredArticle => !!a);
  }

  async listCategories(): Promise<string[]> {
    if (this.categoryCache && Date.now() - this.categoryCache.at < 10 * 60 * 1000) return this.categoryCache.value;
    const res = await getPool().query<{ c: string }>(`SELECT DISTINCT unnest(categories) AS c FROM articles ORDER BY c`);
    this.categoryCache = { at: Date.now(), value: res.rows.map((r) => r.c) };
    return this.categoryCache.value;
  }

  logQuery(e: QueryLogEntry): void {
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

  async cacheGet(questionHash: string): Promise<CachedAnswer | null> {
    const res = await getPool().query<{ answer: string; article_ids: string[] }>(
      `UPDATE answer_cache SET hits = hits + 1 WHERE question_hash = $1 RETURNING answer, article_ids`,
      [questionHash],
    );
    const row = res.rows[0];
    return row ? { answer: row.answer, articleIds: row.article_ids } : null;
  }

  async cacheSet(questionHash: string, question: string, value: CachedAnswer): Promise<void> {
    await getPool().query(
      `INSERT INTO answer_cache (question_hash, question, answer, article_ids) VALUES ($1, $2, $3, $4)
       ON CONFLICT (question_hash) DO NOTHING`,
      [questionHash, question, value.answer, value.articleIds],
    );
  }
}
