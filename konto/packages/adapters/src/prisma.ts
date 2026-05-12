import type { KontoQueryExecutor } from "../../types/src/driver";

function buildQuery(strings: TemplateStringsArray, values: any[]): { text: string; params: any[] } {
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

/**
 * Creates a Konto adapter for Prisma ORM.
 * 
 * @param prisma - The PrismaClient instance
 * @returns A KontoQueryExecutor that executes raw SQL via Prisma's query engine.
 */
export function createPrismaAdapter(prisma: any): KontoQueryExecutor {
  const wrapClient = (client: any): KontoQueryExecutor => {
    const executor: any = async (strings: TemplateStringsArray, ...values: any[]) => {
      const { text, params } = buildQuery(strings, values);
      const res = await client.$queryRawUnsafe(text, ...params);
      return res;
    };

    executor.unsafe = async <T extends any[]>(query: string, parameters?: any[]): Promise<T> => {
      const res = await client.$queryRawUnsafe(query, ...(parameters || []));
      return res as unknown as T;
    };

    executor.begin = async <T>(cb: (tx: KontoQueryExecutor) => Promise<T>): Promise<T> => {
      if (client.$transaction) {
        return client.$transaction(async (tx: any) => {
          const txExecutor = wrapClient(tx);
          return cb(txExecutor);
        });
      } else {
        throw new Error("Konto: Nested transactions are not supported by the Prisma adapter.");
      }
    };

    executor.json = (value: any) => JSON.stringify(value);

    return executor as KontoQueryExecutor;
  };

  return wrapClient(prisma);
}
