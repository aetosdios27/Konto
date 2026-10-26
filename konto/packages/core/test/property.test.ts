import { readFile } from "node:fs/promises";
import postgres from "postgres";
import fc from "fast-check";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase } from "./database";
import { migrate } from "../../cli/src/commands/migrate";
import { createAccount } from "../src/account";
import { transfer } from "../src/transfer";
import { hold, commitHold, rollbackHold } from "../src/hold";
import { getBalance } from "../src/read";
import { KontoInsufficientFundsError, KontoHoldNotFoundError } from "../src/errors";

const operation = fc.record({
  kind: fc.constantFrom("transfer", "hold", "commit", "release", "snapshot"),
  sender: fc.integer({ min: 0, max: 3 }),
  offset: fc.integer({ min: 1, max: 3 }),
  amount: fc.bigInt({ min: 1n, max: 150n }),
  expires: fc.boolean(),
});

describe.each(["schema", "migrations"])("concurrent ledger properties (%s)", (source) => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let connections: ReturnType<typeof postgres>[] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    if (source === "schema") {
      await database.sql.unsafe(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    } else {
      await migrate(database.sql, { migrationsPath: new URL("../../cli/migrations", import.meta.url).pathname });
    }
    connections = Array.from({ length: 8 }, () => postgres(database.url, { max: 1 }));
    const sessions = await Promise.all(connections.map(async (sql) => {
      const [row] = await sql`SELECT pg_backend_pid() AS pid`;
      return row.pid;
    }));
    expect(new Set(sessions).size).toBe(8);
  }, 120000);

  afterAll(async () => {
    await Promise.all(connections.map((sql) => sql.end()));
    await database?.close();
  });

  async function verify(accountIds: string[], released = false) {
    const sql = database.sql;
    for (const accountId of accountIds) {
      await sql.begin(async (tx) => {
        const [expected] = await tx`
          SELECT
            (SELECT COALESCE(SUM(amount), 0)::text FROM konto_entries WHERE account_id = ${accountId}) AS posted,
            (SELECT COALESCE(SUM(amount), 0)::text FROM konto_holds WHERE account_id = ${accountId} AND status = 'PENDING' AND (expires_at IS NULL OR NOW() <= expires_at)) AS reserved
        `;
        const balance = (await getBalance(tx, accountId)).balance;
        expect(balance).toBe(BigInt(expected.posted) - BigInt(expected.reserved));
        if (released) expect(balance).toBe(BigInt(expected.posted));
      });
    }
    const snapshots = await sql`
      SELECT s.id, s.balance::text, COALESCE(SUM(e.amount), 0)::text AS expected
      FROM konto_balance_snapshots s LEFT JOIN konto_entries e
        ON e.account_id = s.account_id AND e.entry_sequence <= s.entry_sequence
      WHERE s.account_id = ANY(${accountIds}::uuid[])
      GROUP BY s.id
    `;
    for (const snapshot of snapshots) expect(snapshot.balance).toBe(snapshot.expected);
  }

  it("preserves posted sums, available balances, and every snapshot prefix across concurrent operations", async () => {
    await fc.assert(fc.asyncProperty(fc.array(operation, { minLength: 20, maxLength: 60 }), async (randomOperations) => {
      const sql = database.sql;
      const bank = await createAccount(sql, { name: crypto.randomUUID(), currency: "INR", account_type: "EQUITY" });
      const accounts = await Promise.all(Array.from({ length: 4 }, () => createAccount(sql, { name: crypto.randomUUID(), currency: "INR" })));
      const ids = accounts.map((account) => account.id);
      await transfer(sql, { accountId: bank.id, entries: [{ accountId: bank.id, amount: -1200n }, ...ids.map((accountId) => ({ accountId, amount: 300n }))] });
      const initialHolds = await Promise.all(ids.map((accountId, index) => hold(sql, { accountId, recipientId: ids[(index + 1) % ids.length], amount: 20n })));
      const mandatory = ["transfer", "hold", "commit", "release", "snapshot"].map((kind, index) => ({ kind, sender: index % 4, offset: 1, amount: 10n, expires: false }));
      const operations = [...mandatory, ...randomOperations];
      for (let start = 0; start < operations.length; start += connections.length) {
        await Promise.all(operations.slice(start, start + connections.length).map(async (op, index) => {
          const connection = connections[index];
          const sender = ids[op.sender];
          const recipient = ids[(op.sender + op.offset) % ids.length];
          try {
            switch (op.kind) {
              case "transfer":
                await transfer(connection, { accountId: sender, entries: [{ accountId: sender, amount: -op.amount }, { accountId: recipient, amount: op.amount }] });
                break;
              case "hold":
                await hold(connection, { accountId: sender, recipientId: recipient, amount: op.amount, ...(op.expires ? { ttlMs: 10 } : {}) });
                break;
              case "commit":
                await commitHold(connection, initialHolds[op.sender].holdId);
                break;
              case "release":
                await rollbackHold(connection, initialHolds[op.sender].holdId);
                break;
              case "snapshot":
                await connection`SELECT take_snapshot(${sender})`;
                break;
              default:
                throw new Error(`Unknown operation: ${op.kind}`);
            }
          } catch (error) {
            if (!(error instanceof KontoInsufficientFundsError || error instanceof KontoHoldNotFoundError)) throw error;
          }
        }));
        await verify([...ids, bank.id]);
      }
      const pending = await sql`SELECT id FROM konto_holds WHERE account_id = ANY(${ids}::uuid[]) AND status = 'PENDING'`;
      await Promise.all(pending.map((row) => rollbackHold(sql, row.id)));
      await verify([...ids, bank.id], true);
      const [total] = await sql`SELECT SUM(amount)::text AS amount FROM konto_entries WHERE account_id = ANY(${[...ids, bank.id]}::uuid[])`;
      expect(total.amount).toBe("0");
    }), { numRuns: 40, seed: source === "schema" ? 20261026 : 20261027 });
  }, 120000);
});
