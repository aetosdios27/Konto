import type { KontoQueryExecutor } from "../../types/src/driver";
import { sql, SQL } from "drizzle-orm";

/**
 * Converts a raw Postgres query with $1, $2 parameters into a Drizzle SQL AST object.
 */
function buildDrizzleSql(query: string, params: any[] = []): SQL {
  const parts = query.split(/\$\d+/);
  const sqlChunks: SQL[] = [];
  
  for (let i = 0; i < parts.length; i++) {
    sqlChunks.push(sql.raw(parts[i]));
    if (i < params.length) {
      sqlChunks.push(sql`${params[i]}`);
    }
  }
  
  return sql.join(sqlChunks, sql.raw(""));
}

/**
 * Creates a Konto adapter for Drizzle ORM.
 * 
 * @param db - The Drizzle database instance
 * @returns A KontoQueryExecutor that safely converts and executes raw SQL through Drizzle.
 */
export function createDrizzleAdapter(db: any): KontoQueryExecutor {
  const wrapClient = (client: any): KontoQueryExecutor => {
    const executor: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      let query = "";
      const params: any[] = [];
      for (let i = 0; i < strings.length; i++) {
        query += strings[i];
        if (i < values.length) {
          const val = values[i];
          params.push(typeof val === "bigint" ? val.toString() : val);
          query += `$${params.length}`;
        }
      }
      const statement = buildDrizzleSql(query, params);
      const result = await client.execute(statement);
      return result.rows ? result.rows : result;
    };

    executor.unsafe = async <T extends any[]>(query: string, parameters?: any[]): Promise<T> => {
      const statement = buildDrizzleSql(query, parameters);
      const result = await client.execute(statement);
      return (result.rows ? result.rows : result) as T;
    };

    executor.begin = async <T>(cb: (tx: KontoQueryExecutor) => Promise<T>): Promise<T> => {
      if (client.transaction) {
        return client.transaction(async (tx: any) => {
          const txExecutor = wrapClient(tx);
          return cb(txExecutor);
        });
      } else {
        throw new Error("Konto: Nested transactions are not supported by the Drizzle adapter.");
      }
    };

    executor.json = (value: any) => JSON.stringify(value);

    return executor as KontoQueryExecutor;
  };

  return wrapClient(db);
}
