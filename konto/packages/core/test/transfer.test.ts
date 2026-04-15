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
  KontoInvalidEntryError,
} from "../src/errors";

describe("Konto Core Engine", () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    sql = postgres(container.getConnectionUri(), { max: 5 });

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
  }, 120000);

  afterAll(async () => {
    if (sql) await sql.end();
    if (container) await container.stop();
  });

  async function setupAccounts(startingBalance: bigint = 1000n) {
    const a = uuidv4();
    const b = uuidv4();
    const external = uuidv4();

    await sql`
      INSERT INTO konto_accounts (id, name, currency)
      VALUES (${a}, 'Alice', 'INR'), (${b}, 'Bob', 'INR'), (${external}, 'Bank', 'INR')
    `;

    const [j] =
      await sql`INSERT INTO konto_journals (description) VALUES ('genesis') RETURNING id`;

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

    const [aliceRow] =
      await sql`SELECT SUM(amount) as bal FROM konto_entries WHERE account_id = ${a}`;
    const [bobRow] =
      await sql`SELECT SUM(amount) as bal FROM konto_entries WHERE account_id = ${b}`;

    expect(BigInt(aliceRow.bal)).toBe(700n);
    expect(BigInt(bobRow.bal)).toBe(300n);
  });

  it("should throw KontoInsufficientFundsError when debit exceeds balance", async () => {
    const { a, b } = await setupAccounts(500n);

    await expect(
      transfer(sql, {
        entries: [
          { accountId: a, amount: -600n },
          { accountId: b, amount: 600n },
        ],
      }),
    ).rejects.toThrow(KontoInsufficientFundsError);

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
          { accountId: b, amount: 90n },
        ],
      }),
    ).rejects.toThrow(KontoUnbalancedTransactionError);
  });

  it("should prevent duplicate transfers via idempotencyKey", async () => {
    const { a, b } = await setupAccounts(1000n);
    const key = `idemp-${Date.now()}`;

    await transfer(sql, {
      idempotencyKey: key,
      entries: [
        { accountId: a, amount: -50n },
        { accountId: b, amount: 50n },
      ],
    });

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

  it("should reject transfers with an amount of zero", async () => {
    const { a, b } = await setupAccounts(100n);

    await expect(
      transfer(sql, {
        entries: [
          { accountId: a, amount: 0n },
          { accountId: b, amount: 0n },
        ],
      }),
    ).rejects.toThrow(KontoInvalidEntryError);
  });

  it("should reject transfers to the same account in a single ledger event", async () => {
    const { a } = await setupAccounts(100n);

    await expect(
      transfer(sql, {
        entries: [
          { accountId: a, amount: -50n },
          { accountId: a, amount: 50n },
        ],
      }),
    ).rejects.toThrow(KontoInvalidEntryError);
  });

  it("should handle 50 concurrent transfers gracefully (CI Concurrency Check)", async () => {
    const { a, b } = await setupAccounts(5000n);
    const CONCURRENCY = 50;

    const promises = Array.from({ length: CONCURRENCY }, (_, i) =>
      transfer(sql, {
        idempotencyKey: `ci-concurrent-${Date.now()}-${i}`,
        entries: [
          { accountId: a, amount: -10n },
          { accountId: b, amount: 10n },
        ],
      }),
    );

    await Promise.all(promises);

    const [aliceRow] =
      await sql`SELECT SUM(amount) as bal FROM konto_entries WHERE account_id = ${a}`;
    const [bobRow] =
      await sql`SELECT SUM(amount) as bal FROM konto_entries WHERE account_id = ${b}`;

    expect(BigInt(aliceRow.bal)).toBe(4500n);
    expect(BigInt(bobRow.bal)).toBe(500n);
  });
});
