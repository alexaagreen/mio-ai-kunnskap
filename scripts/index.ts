import "./_env";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chunkArticle } from "../src/lib/chunk";
import { config } from "../src/lib/config";
import { embeddingsEnabled, getEmbeddingClient } from "../src/lib/embeddings";
import { ArticleSchema, type Article } from "../src/lib/schema";
import { INDEX_PATH, type IndexFile } from "../src/lib/store/file-store";

/**
 * STORE=file: data/canonical/articles.jsonl  ->  data/index/index.json (chunks + embeddings, loaded in memory by the app).
 *
 * Re-uses embeddings from the existing index for articles whose content hasn't changed, so re-running
 * after a small edit only embeds what changed. (For STORE=postgres use scripts/ingest.ts instead.)
 */

const EMBED_BATCH = 64;

function contentHash(a: Article): string {
  return createHash("sha256").update([a.title, a.summary ?? "", a.bodyMd, a.categories.join("|")].join("\n")).digest("hex");
}

async function main() {
  const file = process.argv.find((a) => a.endsWith(".jsonl")) ?? "data/canonical/articles.jsonl";
  const articles = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => ArticleSchema.parse(JSON.parse(line)));
  console.log(`Loaded ${articles.length} articles from ${file}`);

  const embedder = embeddingsEnabled()
    ? getEmbeddingClient()
    : { model: "none", dimensions: 0, embed: async (texts: string[]) => texts.map(() => undefined as unknown as number[]) };
  const previous: IndexFile | null = existsSync(INDEX_PATH) ? (JSON.parse(readFileSync(INDEX_PATH, "utf8")) as IndexFile) : null;
  const reusable =
    previous && previous.embeddingModel === embedder.model && previous.dimensions === embedder.dimensions
      ? new Map(previous.articles.map((a) => [a.id, a.contentHash]))
      : new Map<string, string>();
  const previousChunks = new Map((previous?.chunks ?? []).map((c) => [`${c.articleId}#${c.chunkIndex}`, c]));

  const out: IndexFile = { builtAt: new Date().toISOString(), embeddingModel: embedder.model, dimensions: embedder.dimensions, articles: [], chunks: [] };
  let embedded = 0;
  let reused = 0;

  for (const a of articles) {
    const hash = contentHash(a);
    const { metadata: _metadata, ...rest } = a;
    out.articles.push({ ...rest, contentHash: hash });

    const chunks = chunkArticle(a);
    if (reusable.get(a.id) === hash && chunks.every((c) => previousChunks.has(`${a.id}#${c.chunkIndex}`))) {
      for (const c of chunks) out.chunks.push(previousChunks.get(`${a.id}#${c.chunkIndex}`)!);
      reused++;
      continue;
    }
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      vectors.push(...(await embedder.embed(chunks.slice(i, i + EMBED_BATCH).map((c) => c.content))));
    }
    chunks.forEach((c, i) => out.chunks.push({ articleId: c.articleId, chunkIndex: c.chunkIndex, content: c.content, embedding: vectors[i] }));
    embedded++;
  }

  mkdirSync("data/index", { recursive: true });
  writeFileSync(INDEX_PATH, JSON.stringify(out));
  const mb = (Buffer.byteLength(JSON.stringify(out)) / 1024 / 1024).toFixed(1);
  console.log(`Wrote ${INDEX_PATH}: ${out.articles.length} articles, ${out.chunks.length} chunks, ${mb} MB (${embedded} ${embeddingsEnabled() ? "embedded" : "indexed without embeddings"}, ${reused} reused). Store: ${config.store}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
