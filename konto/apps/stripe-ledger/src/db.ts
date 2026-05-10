import postgres from "postgres";
import type { KontoQueryExecutor } from "@konto-ledger/types";
import { config } from "./config.js";

/**
 * postgres.js tagged-template API natively satisfies KontoQueryExecutor:
 *   - sql<T[]>`...`  → tagged template executor
 *   - sql.begin()    → scoped transaction wrapper
 *   - sql.json()     → JSON parameter serialization
 *   - sql.unsafe()   → bare SQL execution
 *
 * No adapter wrapper needed for a long-running Node.js process.
 */
export const sql = postgres(config.DATABASE_URL) as unknown as KontoQueryExecutor;
