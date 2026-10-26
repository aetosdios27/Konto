import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

export async function createTestDatabase(max = 5) {
  const container = process.env.KONTO_TEST_DATABASE_URL
    ? undefined
    : await new PostgreSqlContainer("postgres:16-alpine").start();
  const adminUrl = process.env.KONTO_TEST_DATABASE_URL ?? container!.getConnectionUri();
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const name = `konto_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await admin`CREATE DATABASE ${admin(name)}`;
  } catch (error) {
    await admin.end();
    await container?.stop();
    throw error;
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max, onnotice: () => {} });
  return {
    sql,
    url: url.toString(),
    async close() {
      await sql.end();
      try {
        await admin`DROP DATABASE ${admin(name)} WITH (FORCE)`;
      } finally {
        await admin.end();
        await container?.stop();
      }
    },
  };
}
