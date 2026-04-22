import type { KontoQueryExecutor } from "../../types/src/driver";

/**
 * createSupabaseAdapter wraps a @supabase/supabase-js client or
 * uses the direct Postgres connection string typically provided by Supabase.
 * Since Supabase provides a standard Postgres connection string, 
 * we recommend using the underlying postgres.js driver directly for performance,
 * but this wrapper is provided for convenience if needed.
 */
export function createSupabaseAdapter(connectionString: string): KontoQueryExecutor {
  // We lazily import postgres to avoid it being a hard dependency for non-Node environments
  // if they don't use this specific adapter, although postgres is used in CLI.
  const postgres = require("postgres");
  const sql = postgres(connectionString);

  const executor: any = async (strings: TemplateStringsArray, ...values: any[]) => {
    return await sql(strings, ...values);
  };

  executor.unsafe = async (query: string, parameters?: any[]) => {
    return await sql.unsafe(query, parameters);
  };

  executor.begin = async <T>(cb: (tx: KontoQueryExecutor) => Promise<T>): Promise<T> => {
    return await sql.begin(async (tx: any) => {
      // The tx object from postgres.js already satisfies KontoQueryExecutor natively
      return await cb(tx as unknown as KontoQueryExecutor);
    });
  };

  executor.json = sql.json;

  return executor as KontoQueryExecutor;
}
