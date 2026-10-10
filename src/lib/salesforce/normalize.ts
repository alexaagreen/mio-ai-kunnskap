import TurndownService from "turndown";
import { ArticleSchema, type Article } from "../schema";
import { salesforceFieldMapping as m } from "./field-mapping";

type Row = Record<string, unknown>;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
// Salesforce rich text often wraps everything in <span style=...>; drop pure styling noise.
turndown.remove(["style", "script"]);

export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(html);
  const md = looksLikeHtml ? turndown.turndown(html) : html;
  return md
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function str(row: Row, field: string): string | undefined {
  const v = row[field];
  if (v === null || v === undefined || v === "") return undefined;
  return String(v);
}

/** Parse inline "Group:Category;Group:Category" into ["Group/Category", ...]. */
function inlineCategories(row: Row): string[] {
  const raw = str(row, m.categories.inlineField);
  if (!raw) return [];
  return raw
    .split(m.categories.inlineSeparator)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(m.categories.inlineGroupSeparator, "/"));
}

/** Build a map KnowledgeArticleId/version Id -> categories from a Knowledge__DataCategorySelection export. */
export function categoriesFromSelections(selections: Row[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const s of selections) {
    const parent = str(s, m.categories.selectionParentField);
    const group = str(s, m.categories.selectionGroupField);
    const name = str(s, m.categories.selectionNameField);
    if (!parent || !name) continue;
    const list = map.get(parent) ?? [];
    list.push(group ? `${group}/${name}` : name);
    map.set(parent, list);
  }
  return map;
}

/**
 * Convert one Salesforce Knowledge__kav row into the canonical Article.
 * Returns null for rows that should be skipped (not Online, no content).
 */
export function normalizeRow(row: Row, selectionCategories?: Map<string, string[]>): Article | null {
  const status = str(row, m.publishStatus.field);
  if (status && status !== m.publishStatus.value) return null;

  const versionId = str(row, "Id");
  const id = str(row, m.id) ?? versionId;
  if (!id) return null;

  // Metadata line first (Dokumenttype, Dokumentansvarlig, ...), then one "## section" per rich-text field.
  const metadata: Record<string, string> = {};
  for (const mf of m.metadataFields) {
    const v = str(row, mf.field);
    if (v) metadata[mf.label] = v.replace(/;/g, ", ");
  }
  const sections: string[] = [];
  const metaLine = Object.entries(metadata)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  if (metaLine) sections.push(metaLine);
  for (const bf of m.bodyFields) {
    const md = htmlToMarkdown(str(row, bf.field));
    if (md) sections.push(m.bodyFields.length > 1 ? `## ${bf.label}\n\n${md}` : md);
  }
  const bodyMd = sections.join("\n\n").trim();
  const title = str(row, m.title);
  if (!title || !bodyMd || sections.length === (metaLine ? 1 : 0)) return null;

  const categories = new Set<string>(inlineCategories(row));
  for (const cf of m.categoryFields) {
    for (const v of (str(row, cf.field) ?? "").split(";")) {
      if (v.trim()) categories.add(`${cf.label}/${v.trim()}`);
    }
  }
  if (selectionCategories) {
    for (const key of [id, versionId]) {
      for (const c of selectionCategories.get(key ?? "") ?? []) categories.add(c);
    }
  }

  const lastPublishedRaw = str(row, m.lastPublished);
  const lastPublished = lastPublishedRaw ? new Date(lastPublishedRaw).toISOString() : undefined;
  const versionRaw = str(row, m.version);

  const candidate = {
    id,
    articleNumber: str(row, m.articleNumber),
    title,
    summary: htmlToMarkdown(str(row, m.summary)) || undefined,
    bodyMd,
    categories: [...categories].sort(),
    language: str(row, m.language) ?? "no",
    version: versionRaw ? Number.parseInt(versionRaw, 10) : undefined,
    lastPublished,
    sourceUrl: versionId ? `${m.instanceUrl}/lightning/r/Knowledge__kav/${versionId}/view` : undefined,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
  return ArticleSchema.parse(candidate);
}
