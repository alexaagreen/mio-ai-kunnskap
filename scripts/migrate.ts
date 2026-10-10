import "./_env";
import { readFileSync } from "node:fs";
import { getPool } from "../src/lib/db";
import { config } from "../src/lib/config";

async function main() {
  let sql = readFileSync("db/schema.sql", "utf8");
  // Keep the vector dimension in sync with EMBEDDING_DIMENSIONS.
  sql = sql.replace(/vector\(\d+\)/g, `vector(${config.embeddings.dimensions})`);
  const pool = getPool();
  await pool.query(sql);
  console.log(`Schema applied (embedding dimension ${config.embeddings.dimensions}).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
