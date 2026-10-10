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
export type EmbeddingProvider = "openai" | "azure-openai";

export const config = {
  databaseUrl: () => env("DATABASE_URL"),

  llm: {
    provider: (process.env.LLM_PROVIDER ?? "anthropic") as LlmProvider,
    answerModel: process.env.ANSWER_MODEL ?? "claude-opus-5-5",
    classifierModel: process.env.CLASSIFIER_MODEL ?? "claude-haiku-5-5",
    answerEffort: (process.env.ANSWER_EFFORT ?? "low") as "low" | "medium" | "high",
    answerMaxTokens: envInt("ANSWER_MAX_TOKENS", 1000),
  },

  embeddings: {
    provider: (process.env.EMBEDDING_PROVIDER ?? "openai") as EmbeddingProvider,
    model: process.env.EMBEDDING_MODEL ?? "text-embedding-3-large",
    dimensions: envInt("EMBEDDING_DIMENSIONS", 1536),
  },

  gates: {
    questionMinChars: envInt("QUESTION_MIN_CHARS", 8),
    questionMaxChars: envInt("QUESTION_MAX_CHARS", 1000),
    retrievalMinScore: envFloat("RETRIEVAL_MIN_SCORE", 0.3),
    answerTopArticles: envInt("ANSWER_TOP_ARTICLES", 4),
    historyMaxMessages: envInt("HISTORY_MAX_MESSAGES", 6),
  },

  chunking: {
    targetTokens: 600,
    overlapTokens: 80,
  },
};
