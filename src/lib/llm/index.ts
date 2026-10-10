import type { z } from "zod";
import { config } from "../config";
import { AnthropicLlm } from "./anthropic";
import { AzureOpenAILlm } from "./azure-openai";

/** Minimal provider-neutral chat message. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface StreamResult {
  /** Async iterator over text deltas (thinking is never surfaced). */
  text: AsyncIterable<string>;
  /** Resolves when the stream finishes. */
  usage: () => Promise<Usage>;
}

export interface StreamParams {
  model: string;
  /** Static part of the system prompt — cached by providers that support it. */
  systemCached: string;
  /** Dynamic part of the system prompt (retrieved articles) — never cached. */
  systemDynamic?: string;
  messages: ChatMessage[];
  maxTokens: number;
  effort?: "low" | "medium" | "high";
}

export interface ClassifyParams<T extends z.ZodType> {
  model: string;
  system: string;
  user: string;
  schema: T;
  maxTokens?: number;
}

export interface LlmClient {
  readonly provider: string;
  stream(params: StreamParams): Promise<StreamResult>;
  /** Small structured-output call (used by the gate-3 classifier). */
  classify<T extends z.ZodType>(params: ClassifyParams<T>): Promise<{ value: z.infer<T>; usage: Usage }>;
}

let singleton: LlmClient | undefined;

/**
 * LLM_PROVIDER switch:
 *   anthropic    -> api.anthropic.com (prototype)
 *   foundry      -> Claude on Microsoft Foundry — same Messages API, different client
 *   azure-openai -> GPT on Azure OpenAI (EU data-residency fallback)
 */
export function getLlm(): LlmClient {
  if (singleton) return singleton;
  switch (config.llm.provider) {
    case "anthropic":
    case "foundry":
      singleton = new AnthropicLlm(config.llm.provider);
      break;
    case "azure-openai":
      singleton = new AzureOpenAILlm();
      break;
    default:
      throw new Error(`Unknown LLM_PROVIDER ${config.llm.provider}`);
  }
  return singleton;
}
