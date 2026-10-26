import postgres from "postgres";

// Singleton connection for Next.js App Router
// In development, Next.js clears the module cache often, which can exhaust DB connections.
const globalForDb = globalThis as unknown as {
  sql: postgres.Sql | undefined;
};

function getSql(): postgres.Sql {
  if (!globalForDb.sql) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error("DATABASE_URL environment variable is required.");
    }
    globalForDb.sql = postgres(dbUrl, { max: 10 });
  }
  return globalForDb.sql;
}

export const sql = new Proxy((() => {}) as unknown as postgres.Sql, {
  get(_target, prop) {
    return (getSql() as any)[prop];
  },
  apply(_target, thisArg, argArray) {
    return (getSql() as any).apply(thisArg, argArray);
  },
});
