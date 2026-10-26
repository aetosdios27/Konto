import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool as PgPool } from "pg";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import WebSocket from "ws";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./.generated/prisma/client";
import type { KontoQueryExecutor } from "@konto-ledger/types";
import { createTestDatabase } from "../../core/test/database";
import { createPostgresProxy } from "./postgres-proxy";
import { createAccount, transfer, transferInTx, hold, stageIntent, executeIntent, getBalance, getJournals, getPendingIntents } from "../../core/src/index";
import { createPrismaAdapter } from "../src/prisma";
import { createDrizzleAdapter } from "../src/drizzle";
import { createVercelAdapter } from "../src/vercel";
import { createKontoClient } from "../src/neon";

const require = createRequire(import.meta.url);
const vercelNeonPath = createRequire(require.resolve("@vercel/postgres")).resolve("@neondatabase/serverless");
const { neonConfig: vercelConfig }: { neonConfig: typeof neonConfig } = await import(new URL("./index.mjs", pathToFileURL(vercelNeonPath)).href);

for (const adapter of ["postgres.js", "prisma", "drizzle-postgres.js", "drizzle-pg", "neon", "vercel"]) {
  describe(`PostgreSQL integration: ${adapter}`, () => {
    let database: Awaited<ReturnType<typeof createTestDatabase>>;
    let db: KontoQueryExecutor;
    let closeDriver: () => Promise<void> = async () => {};
    let proxy: Awaited<ReturnType<typeof createPostgresProxy>> | undefined;
    let alice: string;
    let bob: string;
    const funding = 9007199254740993n;

    beforeAll(async () => {
      database = await createTestDatabase();
      await database.sql.unsafe(await readFile(new URL("../../core/schema.sql", import.meta.url), "utf8"));
      await database.sql`CREATE TABLE app_events (journal_id UUID REFERENCES konto_journals(id), accepted BOOLEAN CHECK (accepted))`;
      if (adapter === "prisma") {
        const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: database.url }) });
        db = createPrismaAdapter(prisma);
        closeDriver = () => prisma.$disconnect();
      } else if (adapter === "drizzle-postgres.js") {
        const client = postgres(database.url);
        db = createDrizzleAdapter(drizzlePostgres(client));
        closeDriver = () => client.end();
      } else if (adapter === "drizzle-pg") {
        const pool = new PgPool({ connectionString: database.url });
        db = createDrizzleAdapter(drizzlePg(pool));
        closeDriver = () => pool.end();
      } else if (adapter === "neon" || adapter === "vercel") {
        proxy = await createPostgresProxy(database.url);
        for (const config of [neonConfig, vercelConfig]) {
          config.webSocketConstructor = WebSocket;
          config.wsProxy = () => proxy!.address;
          config.useSecureWebSocket = false;
          config.pipelineConnect = false;
          config.forceDisablePgSSL = true;
        }
        if (adapter === "neon") {
          const pool = new NeonPool({ connectionString: database.url });
          db = createKontoClient(pool);
          closeDriver = () => pool.end();
        } else {
          db = createVercelAdapter(database.url);
        }
      } else {
        db = database.sql;
      }
      const a = await createAccount(database.sql, { name: "Alice", currency: "INR" });
      const b = await createAccount(database.sql, { name: "Bob", currency: "INR" });
      const bank = await createAccount(database.sql, { name: "Bank", currency: "INR", account_type: "EQUITY" });
      alice = a.id;
      bob = b.id;
      await transfer(database.sql, { accountId: bank.id, entries: [{ accountId: bank.id, amount: -funding }, { accountId: alice, amount: funding }] });
      for (let day = 1; day <= 4; day++) {
        await database.sql.begin(async (tx) => {
          const [journal] = await tx`INSERT INTO konto_journals (account_id, created_at) VALUES (${alice}, ${new Date(Date.UTC(2020, 0, day))}) RETURNING id`;
          await tx`INSERT INTO konto_entries (journal_id, account_id, amount) VALUES (${journal.id}, ${alice}, -1), (${journal.id}, ${bob}, 1)`;
        });
      }
    }, 120000);

    afterAll(async () => {
      await closeDriver();
      await proxy?.close();
      await database?.close();
    });

    it("reads journals without nested fragments and preserves bigint amounts and dates", async () => {
      const journals = await getJournals(db, alice);
      expect(journals).toHaveLength(5);
      expect(journals[0].createdAt).toBeInstanceOf(Date);
      expect(journals[0].entries.some((entry) => entry.amount === funding)).toBe(true);
    });

    it("parameterizes date filters and cursor pagination", async () => {
      const options = { from: new Date("2020-01-01"), to: new Date("2020-01-04"), limit: 2 };
      const first = await getJournals(db, alice, options);
      expect(first).toHaveLength(2);
      const second = await getJournals(db, alice, { ...options, cursorDate: first[1].createdAt, cursorId: first[1].id });
      expect(second).toHaveLength(2);
      expect(new Set([...first, ...second].map((journal) => journal.id)).size).toBe(4);
      const range = await getJournals(db, alice, { from: new Date("2020-01-02"), to: new Date("2020-01-03") });
      expect(range).toHaveLength(2);
      await expect(getJournals(db, "' OR true; --")).rejects.toThrow();
    });

    it("posts transfers and holds and executes all intent types on real transactions", async () => {
      await transfer(db, { accountId: alice, entries: [{ accountId: alice, amount: -10n }, { accountId: bob, amount: 10n }] });
      for (const intentType of ["TRANSFER", "COMMIT_HOLD", "ROLLBACK_HOLD"] as const) {
        const { holdId } = await hold(db, { accountId: alice, recipientId: bob, amount: 10n });
        const payload = intentType === "TRANSFER"
          ? { accountId: alice, entries: [{ accountId: alice, amount: "-10" }, { accountId: bob, amount: "10" }] }
          : { holdId };
        const { intentId } = await stageIntent(db, { intentType, payload });
        expect(await executeIntent(db, intentId)).toMatchObject({ success: true });
      }
      expect((await getBalance(db, bob)).balance).toBe(34n);
    });

    it("rejects expired intents before posting through every driver", async () => {
      const before = (await getBalance(db, bob)).balance;
      const { intentId } = await stageIntent(db, { intentType: "TRANSFER", payload: { accountId: alice, entries: [{ accountId: alice, amount: "-10" }, { accountId: bob, amount: "10" }] } });
      const pending = (await getPendingIntents(db)).find((intent) => intent.id === intentId);
      expect(pending?.expiresAt).toBeInstanceOf(Date);
      expect(pending?.createdAt).toBeInstanceOf(Date);
      await database.sql`UPDATE konto_staged_intents SET expires_at = '2000-01-01' WHERE id = ${intentId}`;
      await expect(executeIntent(db, intentId)).rejects.toThrow(/expired/);
      expect((await getBalance(db, bob)).balance).toBe(before);
    });

    it("atomically commits or rolls back a ledger posting and an event", async () => {
      const before = (await getBalance(db, bob)).balance;
      await expect(db.begin(async (tx) => {
        const { journalId } = await transferInTx(tx, { accountId: alice, entries: [{ accountId: alice, amount: -10n }, { accountId: bob, amount: 10n }] });
        await tx`INSERT INTO app_events (journal_id, accepted) VALUES (${journalId}, false)`;
      })).rejects.toThrow();
      expect((await getBalance(db, bob)).balance).toBe(before);
      const journalId = await db.begin(async (tx) => {
        const { journalId } = await transferInTx(tx, { accountId: alice, entries: [{ accountId: alice, amount: -10n }, { accountId: bob, amount: 10n }] });
        await tx`INSERT INTO app_events (journal_id, accepted) VALUES (${journalId}, true)`;
        return journalId;
      });
      const events = await db`SELECT journal_id FROM app_events WHERE journal_id = ${journalId}`;
      expect(events).toHaveLength(1);
      expect((await getBalance(db, bob)).balance).toBe(before + 10n);
    });
  });
}
