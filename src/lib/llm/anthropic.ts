import Anthropic from "@anthropic-ai/sdk";
import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageCreateParamsStreaming, MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { z } from "zod";
import type { ChatMessage, ClassifyParams, LlmClient, StreamParams, StreamResult, Usage } from "./index";

/**
 * Claude via the direct Anthropic API or via Microsoft Foundry.
 * Both clients expose the same `messages` API, so the only difference is construction.
 *
 * Foundry caveats (see README): no Batches/Files API, no Skills, no server-side web tools.
 * We use only messages.create + prompt caching + structured output, all of which Foundry supports.
 */
export class AnthropicLlm implements LlmClient {
  readonly provider: string;
  private client: Anthropic;

  constructor(provider: "anthropic" | "foundry") {
    this.provider = provider;
    if (provider === "foundry") {
      this.client = new AnthropicFoundry({
        apiKey: process.env.ANTHROPIC_FOUNDRY_API_KEY,
        resource: process.env.ANTHROPIC_FOUNDRY_RESOURCE,
      }) as unknown as Anthropic;
    } else {
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
  }

  private toMessages(messages: ChatMessage[]): MessageParam[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  async stream(params: StreamParams): Promise<StreamResult> {
    const system: TextBlockParam[] = [
      // Static instructions + category tree: cached across requests (cache read = 10% of input price).
      { type: "text", text: params.systemCached, cache_control: { type: "ephemeral" } },
    ];
    if (params.systemDynamic) system.push({ type: "text", text: params.systemDynamic });

    const req: MessageCreateParamsStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system,
      messages: this.toMessages(params.messages),
      stream: true,
      // Opus 5.5 always thinks; keep it adaptive and don't ship the thinking text to the client.
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: params.effort ?? "low" },
    };

    const stream = this.client.messages.stream(req);

    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const text = (async function* () {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        } else if (event.type === "message_start") {
          usage.inputTokens = event.message.usage.input_tokens;
          usage.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
        } else if (event.type === "message_delta") {
          usage.outputTokens = event.usage.output_tokens;
        }
      }
    })();

    return {
      text,
      usage: async () => {
        await stream.finalMessage().catch(() => undefined);
        return usage;
      },
    };
  }

  async classify<T extends z.ZodType>(params: ClassifyParams<T>): Promise<{ value: z.infer<T>; usage: Usage }> {
    const res = await this.client.messages.parse({
      model: params.model,
      max_tokens: params.maxTokens ?? 200,
      system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: params.user }],
      output_config: { effort: "low", format: zodOutputFormat(params.schema) },
    });
    const value = res.parsed_output as z.infer<T>;
    if (value === null || value === undefined) throw new Error("Classifier returned no parsable output");
    return {
      value,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
      },
    };
  }
}
