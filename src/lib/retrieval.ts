import { config } from "./config";
import { getPool, toVectorLiteral } from "./db";
import { getEmbeddingClient } from "./embeddings";

export interface RetrievedArticle {
  id: string;
  articleNumber: string | null;
  title: string;
  summary: string | null;
  bodyMd: string;
  categories: string[];
  sourceUrl: string | null;
  /** Best cosine similarity among this article's chunks (0..1). Used by gate 2. */
  score: number;
  /** Fused rank score (vector + keyword, RRF). Used for ordering. */
  fused: number;
}

interface ChunkHit {
  article_id: string;
  chunk_index: number;
  score: number; // cosine similarity
}

/**
 * Hybrid retrieval: pgvector cosine search + Postgres full-text (Norwegian) search, fused with
 * reciprocal rank fusion, then grouped by article. Returns the top N whole articles.
 *
 * The same SQL runs on Azure Database for PostgreSQL. If Mio prefers Azure AI Search later,
 * this is the only module to replace.
 */
export async function retrieveArticles(question: string, topArticles = config.gates.answerTopArticles): Promise<RetrievedArticle[]> {
  const [embedding] = await getEmbeddingClient().embed([question]);
  const pool = getPool();
  const k = 20;

  const vectorRes = await pool.query<ChunkHit>(
    `SELECT article_id, chunk_index, 1 - (embedding <=> $1::vector) AS score
       FROM chunks
      ORDER BY embedding <=> $1::vector
      LIMIT $2`,
    [toVectorLiteral(embedding), k],
  );

  const keywordRes = await pool.query<ChunkHit>(
    `SELECT article_id, chunk_index, ts_rank_cd(tsv, q) AS score
       FROM chunks, websearch_to_tsquery('norwegian', $1) q
      WHERE tsv @@ q
      ORDER BY score DESC
      LIMIT $2`,
    [question, k],
  );

  // Reciprocal rank fusion per article (best rank per list), keep best cosine for the gate.
  const rrfK = 60;
  const fused = new Map<string, { fused: number; score: number }>();
  const bump = (hits: ChunkHit[], weight: number, isVector: boolean) => {
    const seen = new Set<string>();
    hits.forEach((h, rank) => {
      if (seen.has(h.article_id)) return;
      seen.add(h.article_id);
      const cur = fused.get(h.article_id) ?? { fused: 0, score: 0 };
      cur.fused += weight / (rrfK + rank + 1);
      if (isVector) cur.score = Math.max(cur.score, Number(h.score));
      fused.set(h.article_id, cur);
    });
  };
  bump(vectorRes.rows, 1.0, true);
  bump(keywordRes.rows, 0.7, false);

  const ranked = [...fused.entries()].sort((a, b) => b[1].fused - a[1].fused).slice(0, topArticles);
  if (!ranked.length) return [];

  const ids = ranked.map(([id]) => id);
  const articles = await pool.query<{
    id: string;
    article_number: string | null;
    title: string;
    summary: string | null;
    body_md: string;
    categories: string[];
    source_url: string | null;
  }>(`SELECT id, article_number, title, summary, body_md, categories, source_url FROM articles WHERE id = ANY($1)`, [ids]);

  const byId = new Map(articles.rows.map((a) => [a.id, a]));
  return ranked
    .map(([id, s]) => {
      const a = byId.get(id);
      if (!a) return null;
      return {
        id: a.id,
        articleNumber: a.article_number,
        title: a.title,
        summary: a.summary,
        bodyMd: a.body_md,
        categories: a.categories,
        sourceUrl: a.source_url,
        score: s.score,
        fused: s.fused,
      } satisfies RetrievedArticle;
    })
    .filter((a): a is RetrievedArticle => a !== null);
}

/** Distinct category paths in the KB — used in the classifier and answering system prompts. Cached per process. */
let categoryCache: { at: number; value: string[] } | undefined;
export async function listCategories(): Promise<string[]> {
  if (categoryCache && Date.now() - categoryCache.at < 10 * 60 * 1000) return categoryCache.value;
  const res = await getPool().query<{ c: string }>(`SELECT DISTINCT unnest(categories) AS c FROM articles ORDER BY c`);
  categoryCache = { at: Date.now(), value: res.rows.map((r) => r.c) };
  return categoryCache.value;
}
