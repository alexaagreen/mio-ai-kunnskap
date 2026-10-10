import "./_env";
import { mkdirSync, writeFileSync } from "node:fs";
import { salesforceFieldMapping as m } from "../src/lib/salesforce/field-mapping";

/**
 * Future API-driven path: pull published Knowledge articles straight from Salesforce REST
 * into data/raw/, then run kb:normalize + kb:ingest as usual.
 *
 * Needs SF_INSTANCE_URL and SF_ACCESS_TOKEN (e.g. from `sf org display --json` or a Connected App).
 * In production on Azure this becomes a timer-triggered Function with an OAuth client-credentials flow
 * and a `WHERE LastPublishedDate > :lastRun` filter for incremental sync.
 */

async function soql<T>(query: string): Promise<T[]> {
  const base = process.env.SF_INSTANCE_URL;
  const token = process.env.SF_ACCESS_TOKEN;
  const version = process.env.SF_API_VERSION ?? "v62.0";
  if (!base || !token) throw new Error("SF_INSTANCE_URL and SF_ACCESS_TOKEN are required");

  const records: T[] = [];
  let url: string | null = `${base}/services/data/${version}/query?q=${encodeURIComponent(query)}`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Salesforce ${res.status}: ${await res.text()}`);
    const page = (await res.json()) as { records: T[]; done: boolean; nextRecordsUrl?: string };
    records.push(...page.records);
    url = page.done || !page.nextRecordsUrl ? null : `${base}${page.nextRecordsUrl}`;
  }
  return records;
}

async function main() {
  const language = process.env.SF_LANGUAGE ?? "no";
  const fields = [
    "Id",
    m.id,
    m.articleNumber,
    m.title,
    m.urlName,
    m.summary,
    m.language,
    m.publishStatus.field,
    m.version,
    m.lastPublished,
    ...m.bodyFields.map((b) => b.field),
  ];
  const articles = await soql<Record<string, unknown>>(
    `SELECT ${fields.join(", ")} FROM Knowledge__kav WHERE ${m.publishStatus.field} = '${m.publishStatus.value}' AND ${m.language} = '${language}' AND IsLatestVersion = true`,
  );
  const selections = await soql<Record<string, unknown>>(
    `SELECT ${m.categories.selectionParentField}, ${m.categories.selectionGroupField}, ${m.categories.selectionNameField} FROM Knowledge__DataCategorySelection`,
  );

  mkdirSync("data/raw", { recursive: true });
  writeFileSync("data/raw/Knowledge__kav.json", JSON.stringify({ records: articles }, null, 2));
  writeFileSync("data/raw/Knowledge__DataCategorySelection.json", JSON.stringify({ records: selections }, null, 2));
  console.log(`Fetched ${articles.length} articles and ${selections.length} category selections into data/raw/.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
