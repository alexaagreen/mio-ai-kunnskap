import { Pool } from "pg";
import { config } from "./config";

// One pool per server process (Next.js dev reloads modules, so stash it on globalThis).
const globalForPg = globalThis as unknown as { __mioPool?: Pool };

export function getPool(): Pool {
  if (!globalForPg.__mioPool) {
    globalForPg.__mioPool = new Pool({
      connectionString: config.databaseUrl(),
      max: 5,
      ssl: config.databaseUrl().includes("localhost") || config.databaseUrl().includes("127.0.0.1") ? undefined : { rejectUnauthorized: false },
    });
  }
  return globalForPg.__mioPool;
}

/** Serialize a number[] as a pgvector literal. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
