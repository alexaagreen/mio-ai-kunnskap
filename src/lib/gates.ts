import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "./config";
import { getPool } from "./db";
import { getLlm } from "./llm";
import type { Usage } from "./llm";
import type { RetrievedArticle } from "./retrieval";

/**
 * Gates run cheapest-first so irrelevant questions never reach the answering model:
 *   gate 1  deterministic (length, normalisation, exact-repeat cache)  — free
 *   gate 2  retrieval score threshold                                  — one embedding call
 *   gate 3  Haiku classifier (in_scope / out_of_scope / clarify)       — ~300 cached tokens
 *   gate 4  strict answering prompt + max_tokens                       — the only expensive call
 * Gate 0 (login + rate limiting) is intentionally skipped in the prototype.
 */

export type GateOutcome =
  | { kind: "pass" }
  | { kind: "reject"; gate: "gate1_too_short" | "gate1_too_long" | "gate2_no_match" | "gate3_out_of_scope"; message: string }
  | { kind: "clarify"; gate: "gate3_clarify"; message: string };

export const MESSAGES = {
  tooShort: "Kan du formulere spørsmålet litt mer utfyllende? Da finner jeg riktig artikkel i kunnskapsbasen.",
  tooLong: "Spørsmålet er for langt. Prøv å stille det kortere og mer konkret.",
  noMatch:
    "Dette ser ikke ut til å være dekket av kunnskapsbasen. Jeg svarer kun på spørsmål som er dokumentert der – prøv gjerne å omformulere, eller ta kontakt med den som eier området.",
  outOfScope: "Dette ligger utenfor det kunnskapsbasen dekker, så jeg kan dessverre ikke hjelpe med det her.",
} as const;

// ---------- Gate 1 ----------

export function normalizeQuestion(q: string): string {
  return q.trim().replace(/\s+/g, " ");
}

export function questionHash(q: string): string {
  return createHash("sha256").update(normalizeQuestion(q).toLowerCase()).digest("hex");
}

export function gate1(question: string): GateOutcome {
  const q = normalizeQuestion(question);
  if (q.length < config.gates.questionMinChars) return { kind: "reject", gate: "gate1_too_short", message: MESSAGES.tooShort };
  if (q.length > config.gates.questionMaxChars) return { kind: "reject", gate: "gate1_too_long", message: MESSAGES.tooLong };
  return { kind: "pass" };
}

export async function cacheLookup(question: string): Promise<{ answer: string; articleIds: string[] } | null> {
  const hash = questionHash(question);
  const res = await getPool().query<{ answer: string; article_ids: string[] }>(
    `UPDATE answer_cache SET hits = hits + 1 WHERE question_hash = $1 RETURNING answer, article_ids`,
    [hash],
  );
  const row = res.rows[0];
  return row ? { answer: row.answer, articleIds: row.article_ids } : null;
}

export async function cacheStore(question: string, answer: string, articleIds: string[]): Promise<void> {
  await getPool().query(
    `INSERT INTO answer_cache (question_hash, question, answer, article_ids)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (question_hash) DO NOTHING`,
    [questionHash(question), normalizeQuestion(question), answer, articleIds],
  );
}

// ---------- Gate 2 ----------

export function gate2(articles: RetrievedArticle[]): GateOutcome & { bestScore: number } {
  const bestScore = articles.reduce((m, a) => Math.max(m, a.score), 0);
  if (!articles.length || bestScore < config.gates.retrievalMinScore) {
    return { kind: "reject", gate: "gate2_no_match", message: MESSAGES.noMatch, bestScore };
  }
  return { kind: "pass", bestScore };
}

// ---------- Gate 3 ----------

const ClassificationSchema = z.object({
  verdict: z.enum(["in_scope", "out_of_scope", "clarify"]),
  clarifying_question: z.string().nullable().describe("Only when verdict is clarify: one short question in Norwegian."),
});

export function classifierSystemPrompt(categories: string[]): string {
  return [
    "Du er et filter foran en intern kunnskapsbase for administrasjonen i Mio.",
    "Kunnskapsbasen dekker kun disse områdene:",
    ...categories.map((c) => `- ${c}`),
    "",
    "Avgjør om spørsmålet er noe kunnskapsbasen kan svare på.",
    "- in_scope: spørsmålet handler om rutiner, regler, systemer eller fakta som sannsynligvis er dokumentert i områdene over, og de vedlagte artikkeltitlene ser relevante ut.",
    "- out_of_scope: småprat, generelle spørsmål, koding, oversettelse, kreativ skriving, eller noe som åpenbart ikke hører til områdene over.",
    "- clarify: spørsmålet er relevant, men så vagt at det ikke går an å velge artikkel (f.eks. mangler hvilket system eller hvilken situasjon). Gi da ett kort oppklaringsspørsmål.",
    "Svar kun med JSON.",
  ].join("\n");
}

export async function gate3(question: string, articles: RetrievedArticle[], categories: string[]): Promise<{ outcome: GateOutcome; usage: Usage }> {
  const user = [
    `Spørsmål: ${normalizeQuestion(question)}`,
    "",
    "Artikler som ble funnet ved søk:",
    ...articles.map((a) => `- ${a.title}${a.categories.length ? ` (${a.categories.join(", ")})` : ""}`),
  ].join("\n");

  const { value, usage } = await getLlm().classify({
    model: config.llm.classifierModel,
    system: classifierSystemPrompt(categories),
    user,
    schema: ClassificationSchema,
    maxTokens: 150,
  });

  if (value.verdict === "out_of_scope") return { outcome: { kind: "reject", gate: "gate3_out_of_scope", message: MESSAGES.outOfScope }, usage };
  if (value.verdict === "clarify") {
    return { outcome: { kind: "clarify", gate: "gate3_clarify", message: value.clarifying_question?.trim() || MESSAGES.tooShort }, usage };
  }
  return { outcome: { kind: "pass" }, usage };
}
