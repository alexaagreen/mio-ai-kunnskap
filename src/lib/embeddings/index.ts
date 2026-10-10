import OpenAI, { AzureOpenAI } from "openai";
import { config } from "../config";

export interface EmbeddingClient {
  /** Embed a batch of texts. Returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
  readonly model: string;
  readonly dimensions: number;
}

/**
 * text-embedding-3-large via OpenAI (prototype) or Azure OpenAI (production, EU region).
 * Same model + same `dimensions` => identical vectors, so the index built on Vercel is reusable on Azure.
 */
class OpenAICompatibleEmbeddings implements EmbeddingClient {
  readonly model: string;
  readonly dimensions: number;
  private client: OpenAI;
  private modelParam: string;

  constructor() {
    this.model = config.embeddings.model;
    this.dimensions = config.embeddings.dimensions;
    if (config.embeddings.provider === "azure-openai") {
      this.client = new AzureOpenAI({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21",
      });
      // On Azure the "model" is the deployment name.
      this.modelParam = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ?? this.model;
    } else {
      this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      this.modelParam = this.model;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const res = await this.client.embeddings.create({
      model: this.modelParam,
      input: texts,
      dimensions: this.dimensions,
    });
    return res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

/**
 * Deterministic hash-based embeddings for local development and tests (EMBEDDING_PROVIDER=fake).
 * No API key needed; retrieval quality is poor but the whole pipeline runs end to end.
 */
class FakeEmbeddings implements EmbeddingClient {
  readonly model = "fake";
  readonly dimensions = config.embeddings.dimensions;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dimensions).fill(0);
      for (const word of t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
        let h = 2166136261;
        for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
        v[h % this.dimensions] += 1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

/** False when EMBEDDING_PROVIDER=none: no vectors anywhere; retrieval is keyword search + Haiku router. */
export function embeddingsEnabled(): boolean {
  return config.embeddings.provider !== "none";
}

let singleton: EmbeddingClient | undefined;
export function getEmbeddingClient(): EmbeddingClient {
  if (!embeddingsEnabled()) throw new Error("Embeddings are disabled (EMBEDDING_PROVIDER=none)");
  if (!singleton) {
    singleton = (config.embeddings.provider as string) === "fake" ? new FakeEmbeddings() : new OpenAICompatibleEmbeddings();
  }
  return singleton;
}
