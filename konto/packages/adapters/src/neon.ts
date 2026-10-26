import type { Pool, PoolClient } from "@neondatabase/serverless";
import type { KontoQueryExecutor } from "@konto-ledger/types";

export function buildQuery(strings: TemplateStringsArray, values: unknown[]): { text: string; params: unknown[] } {
  let text = "";
  const params: unknown[] = [];
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      const value = values[i];
      params.push(typeof value === "bigint" ? value.toString() : value);
      text += `$${params.length}`;
    }
  }
  return { text, params };
}

export function createKontoClient(pool: Pool): KontoQueryExecutor {
  const wrapClient = (client: Pool | PoolClient): KontoQueryExecutor => {
    const unsafe = async <T extends unknown[]>(query: string, parameters: unknown[] = []): Promise<T> => {
      const result = await client.query(query, parameters);
      return result.rows as T;
    };
    const executor = async <T extends unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const { text, params } = buildQuery(strings, values);
      return unsafe<T>(text, params);
    };
    return Object.assign(executor, {
      unsafe,
      async begin<T>(cb: (tx: KontoQueryExecutor) => Promise<T>): Promise<T> {
        if ("release" in client) {
          throw new Error("Konto: use the in-transaction API inside an existing Neon transaction.");
        }
        const connection = await client.connect();
        try {
          await connection.query("BEGIN");
          const result = await cb(wrapClient(connection));
          await connection.query("COMMIT");
          return result;
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        } finally {
          connection.release();
        }
      },
      json: (value: unknown) => JSON.stringify(value),
    });
  };
  return wrapClient(pool);
}

export { createKontoClient as createNeonAdapter };
