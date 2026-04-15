import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { v4 as uuidv4 } from "uuid";
import { transfer } from "../src/transfer";
import {
  KontoInsufficientFundsError,
  KontoUnbalancedTransactionError,
  KontoDuplicateTransactionError,
} from "../src/errors";

describe("Konto Core Engine", () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;

  // 1. Spin up ephemeral Postgres container
  beforeAll(async () => {
    // Explicitly pass the image string to bypass Testcontainers parsing bugs
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    sql = postgres(container.getConnectionUri(), { max: 5 });

    // Inject minimal schema for testing
    // FIX: postgres.js strictly requires separate template literals for each statement
    await sql`
      CREATE TABLE konto_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        currency TEXT NOT NULL
      )
    `;

    await sql`
      CREATE TABLE konto_journals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        description TEXT,
        metadata JSONB,
        idempotency_key TEXT UNIQUE
      )
    `;

    await sql`
      CREATE TABLE konto_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        journal_id UUID NOT NULL REFERENCES konto_journals(id),
        account_id UUID NOT NULL REFERENCES konto_accounts(id),
        amount BIGINT NOT NULL
      )
    `;
  }, 120000); // 2-minute safety timeout

  afterAll(async () => {
    // Safe teardown to prevent unhandled rejections if setup fails
    if (sql) await sql.end();
    if (container) await container.stop();
  });

  // Helper to create and fund test accounts per test
  async function setupAccounts(startingBalance: bigint = 1000n) {
    const a = uuidv4();
    const b = uuidv4();
    const external = uuidv4();

    await sql`
      INSERT INTO konto_accounts (id, name, currency)
      VALUES
        (${a}, 'Alice', 'INR'),
        (${b}, 'Bob', 'INR'),
        (${external}, 'Bank', 'INR')
    `;

    // Genesis funding (bypass standard transfer constraints for setup)
    const [j] = await sql`
      INSERT INTO konto_journals (description)
      VALUES ('genesis')
      RETURNING id
    `;

    await sql`
      INSERT INTO konto_entries (journal_id, account_id, amount)
      VALUES (${j.id}, ${a}, ${startingBalance})
    `;

    return { a, b, external };
  }

  // ── THE TESTS ────────────────────────────────────────────────────────────

  it("should successfully execute a valid zero-sum transfer", async () => {
    const { a, b } = await setupAccounts(1000n);

    const { journalId } = await transfer(sql, {
      entries: [
        { accountId: a, amount: -300n },
        { accountId: b, amount: 300n },
      ],
      metadata: { note: "payment for services" },
    });

    expect(journalId).toBeDefined();

    // Verify balances manually via SUM
    const [aliceRow] =
      await sql`SELECT SUM(amount) as bal FROM konto_entries WHERE account_id = ${a}`;
    const [bobRow] =
      await sql`SELECT SUM(amount) as bal FROM konto_entries WHERE account_id = ${b}`;

    expect(BigInt(aliceRow.bal)).toBe(700n); // 1000 - 300
    expect(BigInt(bobRow.bal)).toBe(300n); // 0 + 300
  });

  it("should throw KontoInsufficientFundsError when debit exceeds balance", async () => {
    const { a, b } = await setupAccounts(500n); // Alice only has 500

    await expect(
      transfer(sql, {
        entries: [
          { accountId: a, amount: -600n }, // Tries to spend 600
          { accountId: b, amount: 600n },
        ],
      }),
    ).rejects.toThrow(KontoInsufficientFundsError);

    // Verify state didn't change
    const [aliceRow] =
      await sql`SELECT SUM(amount) as bal FROM konto_entries WHERE account_id = ${a}`;
    expect(BigInt(aliceRow.bal)).toBe(500n);
  });

  it("should throw KontoUnbalancedTransactionError if math is wrong", async () => {
    const { a, b } = await setupAccounts(1000n);

    await expect(
      transfer(sql, {
        entries: [
          { accountId: a, amount: -100n },
          { accountId: b, amount: 90n }, // 10n went missing
        ],
      }),
    ).rejects.toThrow(KontoUnbalancedTransactionError);
  });

  it("should prevent duplicate transfers via idempotencyKey", async () => {
    const { a, b } = await setupAccounts(1000n);
    const key = `idemp-${Date.now()}`;

    // First one succeeds
    await transfer(sql, {
      idempotencyKey: key,
      entries: [
        { accountId: a, amount: -50n },
        { accountId: b, amount: 50n },
      ],
    });

    // Second one with the exact same key fails
    await expect(
      transfer(sql, {
        idempotencyKey: key,
        entries: [
          { accountId: a, amount: -50n },
          { accountId: b, amount: 50n },
        ],
      }),
    ).rejects.toThrow(KontoDuplicateTransactionError);
  });
});
