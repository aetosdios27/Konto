import { createClient } from "@vercel/postgres";
import type { KontoQueryExecutor } from "../../types/src/driver";

/** Converts standard Tagged Templates to parameterized $1, $2 SQL */
function buildQuery(strings: TemplateStringsArray, values: any[]): { text: string; params: any[] } {
  let text = "";
  const params: any[] = [];
  
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      params.push(values[i]);
      text += `$${params.length}`;
    }
  }
  
  return { text, params };
}

export function createVercelAdapter(connectionString?: string): KontoQueryExecutor {
  const getClient = () => createClient(connectionString ? { connectionString } : undefined);

  const wrapClient = (client: { query: any }): KontoQueryExecutor => {
    const executor: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      const { text, params } = buildQuery(strings, values);
      const res = await client.query(text, params);
      return res.rows;
    };

    executor.unsafe = async (query: string, parameters?: any[]) => {
      const res = await client.query(query, parameters);
      return res.rows;
    };

    executor.begin = async <T>(cb: (tx: KontoQueryExecutor) => Promise<T>): Promise<T> => {
      const txClient = getClient();
      await txClient.connect();
      
      try {
        await txClient.query("BEGIN");
        const txExecutor = wrapClient(txClient);
        const result = await cb(txExecutor);
        await txClient.query("COMMIT");
        return result;
      } catch (err) {
        await txClient.query("ROLLBACK");
        throw err;
      } finally {
        await txClient.end();
      }
    };

    executor.json = (value: any) => JSON.stringify(value);

    return executor as KontoQueryExecutor;
  };

  // For non-transactional root queries, we create transient clients.
  // In a real Vercel edge deployment this proxies perfectly to their HTTP endpoints.
  const rootClient = {
    query: async (text: string, params?: any[]) => {
      const tempClient = getClient();
      await tempClient.connect();
      try {
        return await tempClient.query(text, params);
      } finally {
        await tempClient.end();
      }
    }
  };

  return wrapClient(rootClient);
}
