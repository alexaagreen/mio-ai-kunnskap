import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import type { CachedAnswer, CatalogueEntry, ChunkHit, KbStore, QueryLogEntry, StoredArticle } from "./index";

/**
 * In-memory store backed by data/index/index.json (built by `npm run kb:index`).
 *
 * Fine for the prototype (tens to a few hundred articles). For the full 4 000-article KB the index
 * would be ~250 MB of vectors in a JSON file and cold starts would hurt — switch to STORE=postgres.
 */

export interface IndexFile {
  builtAt: string;
  embeddingModel: string;
  dimensions: number;
  articles: StoredArticle[];
  chunks: Array<{ articleId: string; chunkIndex: number; content: string; embedding?: number[] }>;
}

export const INDEX_PATH = path.join(process.cwd(), "data", "index", "index.json");
const LOG_PATH = path.join(process.cwd(), "data", "logs", "query_log.jsonl");

// --- tiny BM25 for the keyword leg of hybrid search ---------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

class Bm25 {
  private docTerms: Map<string, number>[] = [];
  private docLen: number[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  constructor(docs: string[]) {
    for (const d of docs) {
      const terms = tokenize(d);
      const tf = new Map<string, number>();
      for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docTerms.push(tf);
      this.docLen.push(terms.length);
    }
    this.avgLen = this.docLen.reduce((a, b) => a + b, 0) / Math.max(1, this.docLen.length);
  }

  score(query: string): number[] {
    const n = this.docTerms.length;
    const qTerms = [...new Set(tokenize(query))];
    return this.docTerms.map((tf, i) => {
      let s = 0;
      for (const t of qTerms) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5));
        s += idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.docLen[i]) / this.avgLen)));
      }
      return s;
    });
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ----------------------------------------------------------------------------------------------

export class FileStore implements KbStore {
  readonly kind = "file" as const;
  private cache = new Map<string, CachedAnswer>();
  private bm25: Bm25;
  private articlesById: Map<string, StoredArticle>;

  private constructor(private index: IndexFile) {
    this.bm25 = new Bm25(index.chunks.map((c) => c.content));
    this.articlesById = new Map(index.articles.map((a) => [a.id, a]));
  }

  static async load(): Promise<FileStore> {
    let raw: string;
    try {
      raw = await readFile(INDEX_PATH, "utf8");
    } catch {
      throw new Error(`No index at ${INDEX_PATH}. Run \`npm run kb:index\` first (STORE=file).`);
    }
    const index = JSON.parse(raw) as IndexFile;
    const wantModel = config.embeddings.provider === "none" ? "none" : config.embeddings.model;
    if (index.embeddingModel !== wantModel || (wantModel !== "none" && index.dimensions !== config.embeddings.dimensions)) {
      console.warn(
        `index.json was built with ${index.embeddingModel}/${index.dimensions} but config is ${config.embeddings.model}/${config.embeddings.dimensions}. Rebuild with npm run kb:index.`,
      );
    }
    console.log(`[file-store] loaded ${index.articles.length} articles, ${index.chunks.length} chunks (built ${index.builtAt})`);
    return new FileStore(index);
  }

  async listCatalogue(): Promise<CatalogueEntry[]> {
    return this.index.articles.map((a) => ({ id: a.id, articleNumber: a.articleNumber, title: a.title, summary: a.summary, categories: a.categories }));
  }

  async vectorSearch(embedding: number[], k: number): Promise<ChunkHit[]> {
    return this.index.chunks
      .filter((c) => c.embedding && c.embedding.length === embedding.length)
      .map((c) => ({ articleId: c.articleId, chunkIndex: c.chunkIndex, score: cosine(embedding, c.embedding!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async keywordSearch(query: string, k: number): Promise<ChunkHit[]> {
    const scores = this.bm25.score(query);
    return scores
      .map((score, i) => ({ articleId: this.index.chunks[i].articleId, chunkIndex: this.index.chunks[i].chunkIndex, score }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  async getArticles(ids: string[]): Promise<StoredArticle[]> {
    return ids.map((id) => this.articlesById.get(id)).filter((a): a is StoredArticle => !!a);
  }

  async listCategories(): Promise<string[]> {
    return [...new Set(this.index.articles.flatMap((a) => a.categories))].sort();
  }

  logQuery(entry: QueryLogEntry): void {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    console.log(`[query_log] ${line}`);
    // Local dev: also append to a file. On Vercel the filesystem is read-only, so this silently no-ops.
    mkdir(path.dirname(LOG_PATH), { recursive: true })
      .then(() => appendFile(LOG_PATH, line + "\n"))
      .catch(() => undefined);
  }

  async cacheGet(questionHash: string): Promise<CachedAnswer | null> {
    return this.cache.get(questionHash) ?? null; // per-instance; resets on cold start
  }

  async cacheSet(questionHash: string, _question: string, value: CachedAnswer): Promise<void> {
    this.cache.set(questionHash, value);
  }
}
