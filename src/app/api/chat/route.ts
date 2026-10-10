import { z } from "zod";
import { answerQuestion } from "@/lib/answer";

export const runtime = "nodejs";
export const maxDuration = 60;

const BodySchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(20_000) }))
    .min(1)
    .max(40),
  sessionId: z.string().max(100).optional(),
});

/**
 * POST /api/chat
 * Body: { messages: [{role, content}], sessionId? }
 * Response: newline-delimited JSON ChatEvents (meta, text, done, error).
 */
export async function POST(req: Request) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Ugyldig forespørsel" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of answerQuestion({ messages: parsed.data.messages, sessionId: parsed.data.sessionId })) {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        }
      } catch (err) {
        console.error("chat route failed", err);
        controller.enqueue(encoder.encode(JSON.stringify({ type: "error", message: "Uventet feil. Prøv igjen." }) + "\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
