import { config } from "./config";
import { cacheLookup, cacheStore, gate1, gate2, gate3, normalizeQuestion } from "./gates";
import { getLlm, type ChatMessage } from "./llm";
import { logQuery } from "./log";
import { answerSystemPrompt, articlesContext } from "./prompts";
import { listCategories, retrieveArticles, type RetrievedArticle } from "./retrieval";

/** Events streamed to the client as newline-delimited JSON. */
export type ChatEvent =
  | { type: "meta"; gate: string; sources: Array<{ id: string; articleNumber: string | null; title: string; sourceUrl: string | null }> }
  | { type: "text"; delta: string }
  | { type: "done"; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }; latencyMs: number }
  | { type: "error"; message: string };

export interface AnswerInput {
  messages: ChatMessage[];
  sessionId?: string;
  userId?: string;
}

function toSources(articles: RetrievedArticle[]) {
  return articles.map((a) => ({ id: a.id, articleNumber: a.articleNumber, title: a.title, sourceUrl: a.sourceUrl }));
}

/**
 * Runs the gate pipeline and, if everything passes, streams an answer from the answering model.
 * Yields ChatEvents; the API route serialises them.
 */
export async function* answerQuestion(input: AnswerInput): AsyncGenerator<ChatEvent> {
  const started = Date.now();
  const history = input.messages.slice(-config.gates.historyMaxMessages);
  const last = history[history.length - 1];
  if (!last || last.role !== "user") {
    yield { type: "error", message: "Siste melding må være fra brukeren." };
    return;
  }
  const question = normalizeQuestion(last.content);
  const isFirstTurn = history.filter((m) => m.role === "user").length === 1;
  const base = { sessionId: input.sessionId, userId: input.userId, question };

  // Gate 1 — deterministic
  const g1 = gate1(question);
  if (g1.kind === "reject") {
    logQuery({ ...base, gate: g1.gate, latencyMs: Date.now() - started });
    yield { type: "meta", gate: g1.gate, sources: [] };
    yield { type: "text", delta: g1.message };
    yield { type: "done", latencyMs: Date.now() - started };
    return;
  }

  // Gate 1b — exact-repeat cache (single-turn questions only; follow-ups depend on history)
  if (isFirstTurn) {
    const cached = await cacheLookup(question).catch(() => null);
    if (cached) {
      logQuery({ ...base, gate: "cached", articleIds: cached.articleIds, latencyMs: Date.now() - started });
      yield { type: "meta", gate: "cached", sources: [] };
      yield { type: "text", delta: cached.answer };
      yield { type: "done", latencyMs: Date.now() - started };
      return;
    }
  }

  // Retrieval. For follow-ups, embed the previous user turn too so "og hva med refusjon?" still finds the topic.
  const prevUser = [...history.slice(0, -1)].reverse().find((m) => m.role === "user");
  const retrievalQuery = !isFirstTurn && prevUser ? `${prevUser.content}\n${question}` : question;
  const articles = await retrieveArticles(retrievalQuery);

  // Gate 2 — retrieval score
  const g2 = gate2(articles);
  if (g2.kind === "reject") {
    logQuery({ ...base, gate: g2.gate, bestScore: g2.bestScore, articleIds: articles.map((a) => a.id), latencyMs: Date.now() - started });
    yield { type: "meta", gate: g2.gate, sources: [] };
    yield { type: "text", delta: g2.message };
    yield { type: "done", latencyMs: Date.now() - started };
    return;
  }

  // Gate 3 — cheap classifier
  const categories = await listCategories();
  let g3: Awaited<ReturnType<typeof gate3>>;
  try {
    g3 = await gate3(question, articles, categories);
  } catch (err) {
    console.error("classifier failed", err);
    logQuery({ ...base, gate: "error", bestScore: g2.bestScore, articleIds: articles.map((a) => a.id), latencyMs: Date.now() - started });
    yield { type: "error", message: "Klarte ikke å vurdere spørsmålet akkurat nå. Prøv igjen om litt." };
    return;
  }
  if (g3.outcome.kind !== "pass") {
    logQuery({
      ...base,
      gate: g3.outcome.gate,
      bestScore: g2.bestScore,
      articleIds: articles.map((a) => a.id),
      model: config.llm.classifierModel,
      inputTokens: g3.usage.inputTokens,
      outputTokens: g3.usage.outputTokens,
      cacheReadTokens: g3.usage.cacheReadTokens,
      latencyMs: Date.now() - started,
    });
    yield { type: "meta", gate: g3.outcome.gate, sources: g3.outcome.kind === "clarify" ? toSources(articles) : [] };
    yield { type: "text", delta: g3.outcome.message };
    yield { type: "done", latencyMs: Date.now() - started };
    return;
  }

  // Gate 4 — strict answering prompt
  yield { type: "meta", gate: "answered", sources: toSources(articles) };

  const llm = getLlm();
  const stream = await llm.stream({
    model: config.llm.answerModel,
    systemCached: answerSystemPrompt(categories),
    systemDynamic: articlesContext(articles),
    messages: history,
    maxTokens: config.llm.answerMaxTokens,
    effort: config.llm.answerEffort,
  });

  let answer = "";
  try {
    for await (const delta of stream.text) {
      answer += delta;
      yield { type: "text", delta };
    }
  } catch (err) {
    console.error("answer stream failed", err);
    logQuery({ ...base, gate: "error", bestScore: g2.bestScore, articleIds: articles.map((a) => a.id), latencyMs: Date.now() - started });
    yield { type: "error", message: "Noe gikk galt under genereringen av svaret. Prøv igjen." };
    return;
  }

  const usage = await stream.usage();
  const latencyMs = Date.now() - started;
  const articleIds = articles.map((a) => a.id);
  logQuery({
    ...base,
    gate: "answered",
    bestScore: g2.bestScore,
    articleIds,
    answer,
    model: config.llm.answerModel,
    inputTokens: usage.inputTokens + g3.usage.inputTokens,
    outputTokens: usage.outputTokens + g3.usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens + g3.usage.cacheReadTokens,
    latencyMs,
  });
  if (isFirstTurn && answer) cacheStore(question, answer, articleIds).catch(() => undefined);

  yield { type: "done", usage, latencyMs };
}
