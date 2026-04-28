import type { KontoQueryExecutor } from "../../types/src/driver";

export function buildQuery(strings: TemplateStringsArray, values: any[]): { text: string; params: any[] } {
  let text = "";
  const params: any[] = [];
  
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < values.length) {
      const val = values[i];
      params.push(typeof val === "bigint" ? val.toString() : val);
      text += `$${params.length}`;
    }
  }
  
  return { text, params };
}

export function createKontoClient(sql: any): KontoQueryExecutor {
  const wrapClient = (client: any): KontoQueryExecutor => {
    const executor: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      const { text, params } = buildQuery(strings, values);
      return await client(text, params);
    };

    executor.unsafe = async (query: string, parameters?: any[]) => {
      return await client(query, parameters);
    };

    executor.begin = async <T>(cb: (tx: KontoQueryExecutor) => Promise<T>): Promise<T> => {
      return await client.transaction(async (tx: any) => {
        const txExecutor = wrapClient(tx);
        return await cb(txExecutor);
      });
    };

    executor.json = (value: any) => JSON.stringify(value);

    return executor as KontoQueryExecutor;
  };

  return wrapClient(sql);
}
