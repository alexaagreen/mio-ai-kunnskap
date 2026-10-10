import { AzureOpenAI } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import type { ClassifyParams, LlmClient, StreamParams, StreamResult, Usage } from "./index";

/**
 * GPT via Azure OpenAI. Exists so Mio can run with guaranteed EU inference if the Claude-on-Foundry
 * EU data zone isn't available when they go to production. Same interface as the Claude client.
 */
export class AzureOpenAILlm implements LlmClient {
  readonly provider = "azure-openai";
  private client: AzureOpenAI;
  private deployment: string;

  constructor() {
    this.client = new AzureOpenAI({
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-10-21",
    });
    this.deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT ?? "gpt-5";
  }

  async stream(params: StreamParams): Promise<StreamResult> {
    const instructions = [params.systemCached, params.systemDynamic].filter(Boolean).join("\n\n");
    const stream = await this.client.responses.create({
      model: this.deployment,
      instructions,
      input: params.messages.map((m) => ({ role: m.role, content: m.content })),
      max_output_tokens: params.maxTokens,
      stream: true,
    });

    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => (done = resolve));

    const text = (async function* () {
      try {
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") yield event.delta;
          else if (event.type === "response.completed" && event.response.usage) {
            usage.inputTokens = event.response.usage.input_tokens;
            usage.outputTokens = event.response.usage.output_tokens;
            usage.cacheReadTokens = event.response.usage.input_tokens_details?.cached_tokens ?? 0;
          }
        }
      } finally {
        done();
      }
    })();

    return { text, usage: async () => (await finished, usage) };
  }

  async classify<T extends z.ZodType>(params: ClassifyParams<T>): Promise<{ value: z.infer<T>; usage: Usage }> {
    const res = await this.client.responses.parse({
      model: this.deployment,
      instructions: params.system,
      input: [{ role: "user", content: params.user }],
      max_output_tokens: params.maxTokens ?? 200,
      text: { format: zodTextFormat(params.schema as never, "classification") },
    });
    const value = res.output_parsed as z.infer<T>;
    if (value === null || value === undefined) throw new Error("Classifier returned no parsable output");
    return {
      value,
      usage: {
        inputTokens: res.usage?.input_tokens ?? 0,
        outputTokens: res.usage?.output_tokens ?? 0,
        cacheReadTokens: res.usage?.input_tokens_details?.cached_tokens ?? 0,
      },
    };
  }
}
