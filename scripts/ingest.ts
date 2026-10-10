import "./_env";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chunkArticle } from "../src/lib/chunk";
import { getPool, toVectorLiteral } from "../src/lib/db";
import { embeddingsEnabled, getEmbeddingClient } from "../src/lib/embeddings";
import { ArticleSchema, type Article } from "../src/lib/schema";

/**
 * data/canonical/articles.jsonl  ->  Postgres (articles + chunks with embeddings)
 *
 * Idempotent: articles whose content hash is unchanged are skipped, so re-running after a fresh
 * export only embeds what actually changed. Articles no longer in the export are deleted
 * (pass --keep-missing to disable).
 */

const EMBED_BATCH = 64;

function contentHash(a: Article): string {
  return createHash("sha256").update([a.title, a.summary ?? "", a.bodyMd, a.categories.join("|")].join("\n")).digest("hex");
}

async function main() {
  const file = process.argv.find((a) => a.endsWith(".jsonl")) ?? "data/canonical/articles.jsonl";
  const keepMissing = process.argv.includes("--keep-missing");

  const articles = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => ArticleSchema.parse(JSON.parse(line)));
  console.log(`Loaded ${articles.length} articles from ${file}`);

  if (!embeddingsEnabled()) throw new Error("STORE=postgres needs embeddings (pgvector). Set EMBEDDING_PROVIDER=openai or azure-openai.");
  const pool = getPool();
  const embedder = getEmbeddingClient();

  const existing = await pool.query<{ id: string; content_hash: string }>(`SELECT id, content_hash FROM articles`);
  const existingHash = new Map(existing.rows.map((r) => [r.id, r.content_hash]));

  let unchanged = 0;
  let upserted = 0;
  let chunkCount = 0;

  for (const a of articles) {
    const hash = contentHash(a);
    if (existingHash.get(a.id) === hash) {
      unchanged++;
      continue;
    }

    const chunks = chunkArticle(a);
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      vectors.push(...(await embedder.embed(chunks.slice(i, i + EMBED_BATCH).map((c) => c.content))));
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO articles (id, article_number, title, summary, body_md, categories, language, version, last_published, source_url, content_hash, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         ON CONFLICT (id) DO UPDATE SET
           article_number = EXCLUDED.article_number, title = EXCLUDED.title, summary = EXCLUDED.summary,
           body_md = EXCLUDED.body_md, categories = EXCLUDED.categories, language = EXCLUDED.language,
           version = EXCLUDED.version, last_published = EXCLUDED.last_published, source_url = EXCLUDED.source_url,
           content_hash = EXCLUDED.content_hash, updated_at = now()`,
        [a.id, a.articleNumber ?? null, a.title, a.summary ?? null, a.bodyMd, a.categories, a.language, a.version ?? null, a.lastPublished ?? null, a.sourceUrl ?? null, hash],
      );
      await client.query(`DELETE FROM chunks WHERE article_id = $1`, [a.id]);
      for (let i = 0; i < chunks.length; i++) {
        await client.query(`INSERT INTO chunks (article_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4::vector)`, [
          a.id,
          chunks[i].chunkIndex,
          chunks[i].content,
          toVectorLiteral(vectors[i]),
        ]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    upserted++;
    chunkCount += chunks.length;
    if (upserted % 50 === 0) console.log(`  ${upserted} articles embedded…`);
  }

  let deleted = 0;
  if (!keepMissing) {
    const ids = articles.map((a) => a.id);
    const res = await pool.query(`DELETE FROM articles WHERE NOT (id = ANY($1))`, [ids]);
    deleted = res.rowCount ?? 0;
  }

  console.log(`Done. ${upserted} upserted (${chunkCount} chunks), ${unchanged} unchanged, ${deleted} deleted.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
