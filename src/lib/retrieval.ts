import { z } from "zod";
import { config } from "./config";
import { embeddingsEnabled, getEmbeddingClient } from "./embeddings";
import { getLlm, type Usage } from "./llm";
import { getStore, type CatalogueEntry, type ChunkHit, type StoredArticle } from "./store";

export interface RetrievedArticle extends StoredArticle {
  /** Best cosine similarity among this article's chunks (0..1); 1 when picked by the router. Used by gate 2. */
  score: number;
  /** Fused rank score. Used for ordering. */
  fused: number;
}

export interface RouterResult {
  verdict: "in_scope" | "out_of_scope" | "clarify";
  clarifyingQuestion: string | null;
  usage: Usage;
}

export interface RetrievalResult {
  articles: RetrievedArticle[];
  /** Present when EMBEDDING_PROVIDER=none: the router already judged scope, so gate 3 is skipped. */
  router?: RouterResult;
}

const k = 20;
const rrfK = 60;

function fuse(lists: Array<{ hits: ChunkHit[]; weight: number; isVector: boolean }>): Map<string, { fused: number; score: number }> {
  const fused = new Map<string, { fused: number; score: number }>();
  for (const { hits, weight, isVector } of lists) {
    const seen = new Set<string>();
    hits.forEach((h, rank) => {
      if (seen.has(h.articleId)) return;
      seen.add(h.articleId);
      const cur = fused.get(h.articleId) ?? { fused: 0, score: 0 };
      cur.fused += weight / (rrfK + rank + 1);
      if (isVector) cur.score = Math.max(cur.score, h.score);
      fused.set(h.articleId, cur);
    });
  }
  return fused;
}

async function hydrate(ranked: Array<[string, { fused: number; score: number }]>): Promise<RetrievedArticle[]> {
  if (!ranked.length) return [];
  const articles = await (await getStore()).getArticles(ranked.map(([id]) => id));
  const byId = new Map(articles.map((a) => [a.id, a]));
  return ranked
    .map(([id, s]) => {
      const a = byId.get(id);
      return a ? ({ ...a, score: s.score, fused: s.fused } satisfies RetrievedArticle) : null;
    })
    .filter((a): a is RetrievedArticle => a !== null);
}

/**
 * Retrieval, two flavours:
 *  - embeddings on  : vector search + keyword search, reciprocal rank fusion, top N whole articles.
 *  - embeddings off : keyword search for candidates + a Haiku "router" that reads the article catalogue
 *                     (titles, summaries, categories) and picks the relevant articles — and judges scope
 *                     at the same time, so gate 3 is folded into this call. Anthropic key only.
 */
export async function retrieveArticles(question: string, topArticles = config.gates.answerTopArticles): Promise<RetrievalResult> {
  const store = await getStore();

  if (embeddingsEnabled()) {
    const [embedding] = await getEmbeddingClient().embed([question]);
    const [vectorHits, keywordHits] = await Promise.all([store.vectorSearch(embedding, k), store.keywordSearch(question, k)]);
    const fused = fuse([
      { hits: vectorHits, weight: 1.0, isVector: true },
      { hits: keywordHits, weight: 0.7, isVector: false },
    ]);
    const ranked = [...fused.entries()].sort((a, b) => b[1].fused - a[1].fused).slice(0, topArticles);
    return { articles: await hydrate(ranked) };
  }

  // --- no embeddings: keyword candidates + router ---
  const keywordHits = await store.keywordSearch(question, k);
  const keywordIds = [...new Set(keywordHits.map((h) => h.articleId))];
  const catalogue = await store.listCatalogue();
  const menu =
    catalogue.length <= config.gates.routerCatalogueMax
      ? catalogue
      : catalogue.filter((c) => keywordIds.includes(c.id)); // large KB: only keyword candidates
  let router: Awaited<ReturnType<typeof routeQuestion>>;
  try {
    router = await routeQuestion(question, menu, keywordIds.slice(0, 5), topArticles);
  } catch (err) {
    // Router hiccup (truncated JSON, transient API error): fall back to keyword candidates and let gate 3 judge scope.
    console.error("router failed, falling back to keyword search", err);
    const ranked: Array<[string, { fused: number; score: number }]> = keywordIds.slice(0, topArticles).map((id, i) => [id, { fused: 1 / (i + 1), score: 1 }]);
    return { articles: await hydrate(ranked) };
  }

  const ranked: Array<[string, { fused: number; score: number }]> = router.articleIds.map((id, i) => [id, { fused: 1 / (i + 1), score: 1 }]);
  return { articles: await hydrate(ranked), router: { verdict: router.verdict, clarifyingQuestion: router.clarifyingQuestion, usage: router.usage } };
}

const RouteSchema = z.object({
  verdict: z.enum(["in_scope", "out_of_scope", "clarify"]),
  article_ids: z.array(z.string()).describe("IDs of the articles that most likely contain the answer, best first. Empty if none."),
  clarifying_question: z.string().nullable().describe("Only when verdict is clarify: one short question in Norwegian."),
});

export function routerSystemPrompt(menu: CatalogueEntry[]): string {
  const lines = menu.map((c) => {
    const cats = c.categories.length ? ` [${c.categories.join("; ")}]` : "";
    const sum = c.summary ? ` — ${c.summary.slice(0, 200)}` : "";
    return `- id=${c.id}: ${c.title}${cats}${sum}`;
  });
  return [
    "Du er ruter foran en intern kunnskapsbase for administrasjonen i Mio. Du får et spørsmål og katalogen over artikler.",
    "Oppgave: velg de artiklene (maks 4) som mest sannsynlig inneholder svaret, og avgjør om spørsmålet er innenfor det kunnskapsbasen dekker.",
    "- in_scope: spørsmålet handler om rutiner, regler, systemer eller fakta som sannsynligvis er dokumentert i en av artiklene. Returner article_ids.",
    "- out_of_scope: småprat, generelle spørsmål, koding, oversettelse, kreativ skriving, eller tema ingen artikkel dekker. Returner tom article_ids.",
    "- clarify: relevant, men for vagt til å velge artikkel (mangler f.eks. hvilket selskap eller hvilken situasjon). Gi ett kort oppklaringsspørsmål.",
    "Bruk kun id-ene fra katalogen. Svar kun med JSON.",
    "",
    "Katalog:",
    ...lines,
  ].join("\n");
}

async function routeQuestion(question: string, menu: CatalogueEntry[], keywordHint: string[], max: number) {
  const valid = new Set(menu.map((c) => c.id));
  const hint = keywordHint.length ? `\n\nNøkkelordsøk traff disse id-ene (kan være relevante, men ikke nødvendigvis): ${keywordHint.join(", ")}` : "";
  const { value, usage } = await getLlm().classify({
    model: config.llm.classifierModel,
    system: routerSystemPrompt(menu), // cached: the catalogue only changes when the KB is rebuilt
    user: `Spørsmål: ${question}${hint}`,
    schema: RouteSchema,
    maxTokens: 2048,
  });
  const articleIds = [...new Set(value.article_ids)].filter((id) => valid.has(id)).slice(0, max);
  return { verdict: value.verdict, clarifyingQuestion: value.clarifying_question, articleIds, usage };
}

/** Distinct category paths in the KB — used in the classifier and answering system prompts. */
export async function listCategories(): Promise<string[]> {
  return (await getStore()).listCategories();
}
