import { config } from "./config";
import type { Article } from "./schema";

/** Rough token estimate (Norwegian text averages ~4 chars/token with cl100k-style tokenizers). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Chunk {
  articleId: string;
  chunkIndex: number;
  content: string; // what gets embedded: header + body slice
}

/**
 * Split an article into ~targetTokens chunks on paragraph boundaries with a small overlap.
 * Every chunk is prefixed with title + categories so the embedding carries the article context.
 */
export function chunkArticle(article: Article): Chunk[] {
  const { targetTokens, overlapTokens } = config.chunking;
  const header = [`Tittel: ${article.title}`, article.categories.length ? `Kategori: ${article.categories.join(", ")}` : null]
    .filter(Boolean)
    .join("\n");
  const headerTokens = estimateTokens(header);
  const budget = Math.max(150, targetTokens - headerTokens);

  const paragraphs = article.bodyMd.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (article.summary) paragraphs.unshift(article.summary);

  const bodies: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length) bodies.push(current.join("\n\n"));
  };

  for (const p of paragraphs) {
    const pTokens = estimateTokens(p);
    if (pTokens > budget) {
      // Very long paragraph: hard-split by sentences.
      flush();
      current = [];
      currentTokens = 0;
      const sentences = p.split(/(?<=[.!?])\s+/);
      let buf: string[] = [];
      let bufTokens = 0;
      for (const s of sentences) {
        const st = estimateTokens(s);
        if (bufTokens + st > budget && buf.length) {
          bodies.push(buf.join(" "));
          buf = [];
          bufTokens = 0;
        }
        buf.push(s);
        bufTokens += st;
      }
      if (buf.length) bodies.push(buf.join(" "));
      continue;
    }
    if (currentTokens + pTokens > budget && current.length) {
      flush();
      // Overlap: carry the tail of the previous chunk into the next one.
      const tail: string[] = [];
      let tailTokens = 0;
      for (let i = current.length - 1; i >= 0 && tailTokens < overlapTokens; i--) {
        tail.unshift(current[i]);
        tailTokens += estimateTokens(current[i]);
      }
      current = tail;
      currentTokens = tailTokens;
    }
    current.push(p);
    currentTokens += pTokens;
  }
  flush();

  if (!bodies.length) bodies.push(article.title);

  return bodies.map((body, i) => ({
    articleId: article.id,
    chunkIndex: i,
    content: `${header}\n\n${body}`,
  }));
}
