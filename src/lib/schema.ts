import { z } from "zod";

/**
 * Canonical article shape. This is the contract between ingestion and the app.
 * Salesforce (file export today, REST API later) is mapped INTO this shape by src/lib/salesforce/normalize.ts;
 * nothing downstream knows about Salesforce field names.
 */
export const ArticleSchema = z.object({
  id: z.string().min(1), // KnowledgeArticleId — stable across versions
  articleNumber: z.string().optional(),
  title: z.string().min(1),
  summary: z.string().optional(),
  bodyMd: z.string(), // Markdown (converted from Salesforce rich text HTML)
  categories: z.array(z.string()).default([]), // "Group/Category" paths, e.g. "Kundeservice/Refusjon"
  language: z.string().default("no"),
  version: z.number().int().optional(),
  lastPublished: z.string().datetime({ offset: true }).optional(),
  sourceUrl: z.string().url().optional(),
  /** Free-form source metadata (e.g. Dokumentansvarlig, Neste revidering). Kept for display/debugging. */
  metadata: z.record(z.string(), z.string()).optional(),
});

export type Article = z.infer<typeof ArticleSchema>;

export const ArticleListSchema = z.array(ArticleSchema);
