import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import path from "path";
import { migrate } from "../src/commands/migrate";
import { createAccount } from "@konto-ledger/core";
import { transfer } from "@konto-ledger/core";
import { getBalance } from "@konto-ledger/core";

/**
 * End-to-end integration test for the CLI migration flow.
 *
 * This test would have caught the schema drift between
 * cli/migrations/0001 and core/schema.sql months ago.
 *
 * Flow: start Postgres → run all migrations → createAccount →
 *       transfer → getBalance → verify correctness
 */
describe("CLI End-to-End: init → migrate → transfer → getBalance", () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    sql = postgres(container.getConnectionUri(), { max: 5 });
  }, 120000);

  afterAll(async () => {
    if (sql) await sql.end();
    if (container) await container.stop();
  });

  it("should apply all migrations and produce a schema that supports core operations", async () => {
    // ── Step 1: Run migrations ─────────────────────────────────────────
    const migrationsPath = path.resolve(__dirname, "../migrations");
    const { applied } = await migrate(sql as any, { migrationsPath });

    expect(applied.length).toBeGreaterThanOrEqual(4);
    expect(applied).toContain("0001_initial_state.sql");
    expect(applied).toContain("0002_add_active_hold_index.sql");
    expect(applied).toContain("0003_reconcile_schema.sql");
    expect(applied).toContain("0004_account_name_unique.sql");

    // ── Step 2: Verify migration tracking table ────────────────────────
    const migrations = await sql<{ migration_name: string }[]>`
      SELECT migration_name FROM _konto_migrations ORDER BY applied_at ASC
    `;
    expect(migrations.map((m) => m.migration_name)).toEqual(applied);

    // ── Step 3: Create accounts ────────────────────────────────────────
    const alice = await createAccount(sql as any, {
      name: "Alice",
      currency: "USD",
    });
    const bob = await createAccount(sql as any, {
      name: "Bob",
      currency: "USD",
    });
    const bank = await createAccount(sql as any, {
      name: "Bank",
      currency: "USD",
      account_type: "EQUITY",
    });

    expect(alice.id).toBeDefined();
    expect(bob.id).toBeDefined();
    expect(bank.id).toBeDefined();

    // ── Step 4: Verify UNIQUE constraint on name ───────────────────────
    await expect(
      createAccount(sql as any, { name: "Alice", currency: "USD" })
    ).rejects.toThrow();

    // ── Step 5: Fund Alice via genesis transfer ────────────────────────
    const { journalId: genesisId } = await transfer(sql as any, {
      accountId: bank.id,
      entries: [
        { accountId: bank.id, amount: -10000n },
        { accountId: alice.id, amount: 10000n },
      ],
    });
    expect(genesisId).toBeDefined();

    // ── Step 6: Transfer Alice → Bob ───────────────────────────────────
    const { journalId: transferId } = await transfer(sql as any, {
      accountId: alice.id,
      idempotencyKey: "test-transfer-001",
      entries: [
        { accountId: alice.id, amount: -3000n },
        { accountId: bob.id, amount: 3000n },
      ],
    });
    expect(transferId).toBeDefined();

    // ── Step 7: Verify idempotency ─────────────────────────────────────
    await expect(
      transfer(sql as any, {
        accountId: alice.id,
        idempotencyKey: "test-transfer-001",
        entries: [
          { accountId: alice.id, amount: -3000n },
          { accountId: bob.id, amount: 3000n },
        ],
      })
    ).rejects.toThrow();

    // ── Step 8: Verify balances ────────────────────────────────────────
    const aliceBalance = await getBalance(sql as any, alice.id);
    const bobBalance = await getBalance(sql as any, bob.id);

    expect(aliceBalance.balance).toBe(7000n);
    expect(aliceBalance.currency).toBe("USD");
    expect(bobBalance.balance).toBe(3000n);

    // ── Step 9: Verify zero-sum trigger ────────────────────────────────
    // Attempt to insert an unbalanced entry directly — the deferred
    // constraint trigger must reject it at commit time.
    await expect(
      sql.begin(async (tx) => {
        const [j] = await tx`
          INSERT INTO konto_journals (account_id, description)
          VALUES (${alice.id}, 'invalid')
          RETURNING id
        `;
        await tx`
          INSERT INTO konto_entries (journal_id, account_id, amount)
          VALUES (${j.id}, ${alice.id}, 9999)
        `;
        // The trigger fires at commit — this should fail
      })
    ).rejects.toThrow(/unbalanced/i);

    // ── Step 10: Verify take_snapshot() exists and works ───────────────
    const [{ take_snapshot: snapshotId }] = await sql<{ take_snapshot: string }[]>`
      SELECT take_snapshot(${alice.id})
    `;
    expect(snapshotId).toBeDefined();

    // Balance should be unchanged after snapshot
    const postSnapshotBalance = await getBalance(sql as any, alice.id);
    expect(postSnapshotBalance.balance).toBe(7000n);
  }, 120000);
});
