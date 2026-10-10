import "./_env";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { categoriesFromSelections, normalizeRow } from "../src/lib/salesforce/normalize";
import type { Article } from "../src/lib/schema";

/**
 * Raw Salesforce export  ->  data/canonical/articles.jsonl
 *
 * Usage:
 *   npm run kb:normalize                     # reads every .csv/.json in data/raw
 *   npm run kb:normalize -- data/sample      # reads a different folder (e.g. the bundled sample)
 *
 * Accepted inputs in the folder:
 *   - Knowledge__kav export as CSV (Data Loader / Workbench) or JSON ({ records: [...] } from the REST API, or a bare array)
 *   - optional Knowledge__DataCategorySelection export, file name containing "DataCategory"
 *   - already-canonical JSON arrays (used by the sample data) are passed through after validation
 */

type Row = Record<string, unknown>;

function readRows(file: string): Row[] {
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".csv")) {
    return parse(text, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true }) as Row[];
  }
  const json = JSON.parse(text) as unknown;
  if (Array.isArray(json)) return json as Row[];
  if (json && typeof json === "object" && Array.isArray((json as { records?: unknown }).records)) return (json as { records: Row[] }).records;
  throw new Error(`Unrecognised JSON shape in ${file}`);
}

function isCanonical(row: Row): boolean {
  return typeof row.bodyMd === "string" && typeof row.title === "string" && typeof row.id === "string";
}

function main() {
  const inDir = process.argv[2] ?? "data/raw";
  const outDir = "data/canonical";
  mkdirSync(outDir, { recursive: true });

  const files = existsSync(inDir) ? readdirSync(inDir).filter((f) => /\.(csv|json)$/i.test(f)) : [];
  if (!files.length) {
    console.error(`No .csv/.json files in ${inDir}. Put the Salesforce export there (see README).`);
    process.exit(1);
  }

  const selectionFiles = files.filter((f) => /datacategory/i.test(f));
  const articleFiles = files.filter((f) => !selectionFiles.includes(f));

  const selections = selectionFiles.flatMap((f) => readRows(join(inDir, f)));
  const categoryMap = selections.length ? categoriesFromSelections(selections) : undefined;

  const articles = new Map<string, Article>();
  let skipped = 0;
  for (const f of articleFiles) {
    for (const row of readRows(join(inDir, f))) {
      const article = isCanonical(row) ? (row as unknown as Article) : normalizeRow(row, categoryMap);
      if (!article) {
        skipped++;
        continue;
      }
      // If several versions of the same article slip through, keep the highest version.
      const existing = articles.get(article.id);
      if (!existing || (article.version ?? 0) >= (existing.version ?? 0)) articles.set(article.id, article);
    }
  }

  const out = join(outDir, "articles.jsonl");
  writeFileSync(out, [...articles.values()].map((a) => JSON.stringify(a)).join("\n") + "\n");
  console.log(`Wrote ${articles.size} articles to ${out} (${skipped} rows skipped: not Online or empty).`);
}

main();
