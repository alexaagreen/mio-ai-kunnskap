import { getStore, type QueryLogEntry } from "./store";

export type { QueryLogEntry };

/** Fire-and-forget; logging must never break a response. */
export function logQuery(e: QueryLogEntry): void {
  getStore()
    .then((s) => s.logQuery(e))
    .catch((err) => console.error("query log failed", err));
}
