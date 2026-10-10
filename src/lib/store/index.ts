import { config } from "../config";
import type { Article } from "../schema";

/**
 * Storage backend for the knowledge base, the query log and the answer cache.
 *
 *   STORE=file      (prototype) — everything lives in data/index/index.json, built by `npm run kb:index`,
 *                   loaded into memory on startup. No database. Query log goes to stdout (Vercel logs)
 *                   and, when the filesystem is writable, to data/logs/query_log.jsonl.
 *   STORE=postgres  (live)      — Postgres + pgvector (Neon/Supabase → Azure Database for PostgreSQL).
 *                   See src/lib/store/pg-store.ts and db/schema.sql.
 *
 * Nothing outside this folder knows which backend is active.
 */

export interface ChunkHit {
  articleId: string;
  chunkIndex: number;
  /** Vector: cosine similarity (0..1). Keyword: relevance score (unbounded). */
  score: number;
}

export interface StoredArticle extends Omit<Article, "metadata"> {
  contentHash: string;
}

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

export interface CachedAnswer {
  answer: string;
  articleIds: string[];
}

export interface CatalogueEntry {
  id: string;
  articleNumber?: string;
  title: string;
  summary?: string;
  categories: string[];
}

export interface KbStore {
  readonly kind: "file" | "postgres";
  /** Lightweight list of every article (no bodies) — the Haiku router's menu when embeddings are off. */
  listCatalogue(): Promise<CatalogueEntry[]>;
  vectorSearch(embedding: number[], k: number): Promise<ChunkHit[]>;
  keywordSearch(query: string, k: number): Promise<ChunkHit[]>;
  getArticles(ids: string[]): Promise<StoredArticle[]>;
  listCategories(): Promise<string[]>;
  logQuery(entry: QueryLogEntry): void;
  cacheGet(questionHash: string): Promise<CachedAnswer | null>;
  cacheSet(questionHash: string, question: string, value: CachedAnswer): Promise<void>;
}

let singleton: Promise<KbStore> | undefined;

export function getStore(): Promise<KbStore> {
  if (!singleton) {
    singleton = (async () => {
      if (config.store === "postgres") {
        const { PgStore } = await import("./pg-store");
        return new PgStore();
      }
      const { FileStore } = await import("./file-store");
      return FileStore.load();
    })();
    singleton.catch(() => (singleton = undefined)); // allow a retry after a failed load
  }
  return singleton;
}
