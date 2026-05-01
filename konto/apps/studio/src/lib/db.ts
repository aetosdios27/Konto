import postgres from "postgres";

const dbUrl = process.env.DATABASE_URL;

if (!dbUrl) {
  throw new Error("DATABASE_URL environment variable is required.");
}

// Singleton connection for Next.js App Router
// In development, Next.js clears the module cache often, which can exhaust DB connections.
const globalForDb = globalThis as unknown as {
  sql: postgres.Sql | undefined;
};

export const sql = globalForDb.sql ?? postgres(dbUrl, { max: 10 });

if (process.env.NODE_ENV !== "production") {
  globalForDb.sql = sql;
}
