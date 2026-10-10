// Central config. Everything that should change between prototype (Vercel + Anthropic) and
// production (Azure + Foundry / Azure OpenAI) is an environment variable, not code.

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number.parseInt(v, 10) : fallback;
}

function envFloat(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number.parseFloat(v) : fallback;
}

export type LlmProvider = "anthropic" | "foundry" | "azure-openai";
export type EmbeddingProvider = "openai" | "azure-openai" | "none";

export type StoreKind = "file" | "postgres";

export const config = {
  /** file = data/index/index.json in memory (prototype). postgres = pgvector (live). */
  store: (process.env.STORE ?? "file") as StoreKind,
  databaseUrl: () => env("DATABASE_URL"),

  llm: {
    provider: (process.env.LLM_PROVIDER ?? "anthropic") as LlmProvider,
    answerModel: process.env.ANSWER_MODEL ?? "claude-opus-5-5",
    classifierModel: process.env.CLASSIFIER_MODEL ?? "claude-haiku-5-5",
    answerEffort: (process.env.ANSWER_EFFORT ?? "low") as "low" | "medium" | "high",
    answerMaxTokens: envInt("ANSWER_MAX_TOKENS", 4000), // includes adaptive-thinking tokens on 5.5 models
  },

  embeddings: {
    /** none = no vector search; retrieval is keyword search + a Haiku router over the article catalogue (Anthropic key only). */
    provider: (process.env.EMBEDDING_PROVIDER ?? "none") as EmbeddingProvider,
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-large",
    dimensions: envInt("EMBEDDING_DIMENSIONS", 1536),
  },

  gates: {
    questionMinChars: envInt("QUESTION_MIN_CHARS", 8),
    questionMaxChars: envInt("QUESTION_MAX_CHARS", 1000),
    retrievalMinScore: envFloat("RETRIEVAL_MIN_SCORE", 0.3),
    answerTopArticles: envInt("ANSWER_TOP_ARTICLES", 4),
    /** EMBEDDING_PROVIDER=none: the router sees the whole catalogue when the KB has at most this many articles, otherwise only keyword candidates. */
    routerCatalogueMax: envInt("ROUTER_CATALOGUE_MAX", 300),
    historyMaxMessages: envInt("HISTORY_MAX_MESSAGES", 6),
  },

  chunking: {
    targetTokens: 600,
    overlapTokens: 80,
  },
};
