import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { transfer } from "../src/transfer";
import { hold, commitHold, rollbackHold } from "../src/hold";
import { KontoInsufficientFundsError } from "../src/errors";
import { getBalance } from "../src/read";

describe("Konto Escrow Engine - Pathological Benchmark", () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    sql = postgres(container.getConnectionUri(), { max: 100 }); // Increase connection pool for stress test

    const schemaPath = path.resolve(__dirname, "../schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf-8");
    
    // Postgres.js allows executing raw sql files by just passing the string if we split them, or using sql.unsafe
    await sql.unsafe(schemaSql);
  }, 120000);

  afterAll(async () => {
    if (sql) await sql.end();
    if (container) await container.stop();
  });

  async function createFundedAccounts(startingBalance: bigint = 1000n) {
    const alice = uuidv4();
    const bob = uuidv4();
    const bank = uuidv4();

    await sql`
      INSERT INTO konto_accounts (id, name, currency)
      VALUES
        (${alice}, 'Alice', 'INR'),
        (${bob}, 'Bob', 'INR'),
        (${bank}, 'Bank', 'INR')
    `;

    const [journal] =
      await sql`INSERT INTO konto_journals (description) VALUES ('genesis') RETURNING id`;

    await sql`
      INSERT INTO konto_entries (journal_id, account_id, amount)
      VALUES
        (${journal.id}, ${alice}, ${startingBalance.toString()}),
        (${journal.id}, ${bank}, ${(-startingBalance).toString()})
    `;

    return { alice, bob, bank };
  }

  it("should survive 1000+ concurrent transfers and holds without deadlocks and maintain conservation of value", async () => {
    const NUM_ACCOUNTS = 50;
    const INITIAL_FUNDING = 10000n;
    const TOTAL_SYSTEM_VALUE = BigInt(NUM_ACCOUNTS) * INITIAL_FUNDING;
    const CONCURRENCY = 1000;

    // 1. Setup 50 Accounts
    const accountIds: string[] = [];
    for (let i = 0; i < NUM_ACCOUNTS; i++) {
        const id = uuidv4();
        await sql`INSERT INTO konto_accounts (id, name, currency) VALUES (${id}, ${'StressAccount_' + i}, 'INR')`;
        accountIds.push(id);
    }

    // 2. Genesis Funding
    const [genesisJournal] = await sql`INSERT INTO konto_journals (description) VALUES ('genesis_funding') RETURNING id`;
    
    await sql`
      INSERT INTO konto_entries (journal_id, account_id, amount)
      SELECT * FROM UNNEST(
        ${accountIds.map(() => genesisJournal.id)}::uuid[],
        ${accountIds}::uuid[],
        ${accountIds.map(() => INITIAL_FUNDING.toString())}::bigint[]
      )
    `;

    // 3. Stress Loop
    // We will generate the promises
    // To properly test commit/rollback we need active holds. 
    // We will do 400 transfers, 600 holds. Then randomly commit 300 holds and rollback 300 holds.
    // However, to make it completely concurrent and chaotic, we'll spawn them randomly in an array of promises.
    // Hold operations might fail with InsufficientFunds if random chance depletes an account, we simply catch and ignore it for the deadlock check.
    
    const randomAccount = () => accountIds[Math.floor(Math.random() * accountIds.length)]!;

    const promises: Promise<any>[] = [];
    const holdIdsToResolve: string[] = [];
    
    // First, let's fire 500 random transfers and 500 holds
    for(let i = 0; i < CONCURRENCY; i++) {
        const isTransfer = Math.random() < 0.5;
        const a = randomAccount();
        let b = randomAccount();
        while (b === a) b = randomAccount();

        const amount = BigInt(Math.floor(Math.random() * 50) + 1); // 1 to 50

        if (isTransfer) {
            promises.push(
                transfer(sql, {
                    entries: [
                        { accountId: a, amount: -amount },
                        { accountId: b, amount: amount }
                    ]
                }).catch(e => {
                    if (!(e instanceof KontoInsufficientFundsError)) throw e;
                })
            );
        } else {
            promises.push(
                hold(sql, {
                    accountId: a,
                    recipientId: b,
                    amount: amount
                }).then(res => {
                    holdIdsToResolve.push(res.holdId);
                }).catch(e => {
                    if (!(e instanceof KontoInsufficientFundsError)) throw e;
                })
            );
        }
    }

    // Wait for the first chaotic wave
    await Promise.all(promises);

    // Second chaotic wave: resolve all those holds (commit half, rollback half) concurrently
    const resolvePromises: Promise<any>[] = [];
    for(const holdId of holdIdsToResolve) {
        const isCommit = Math.random() < 0.5;
        if(isCommit) {
            resolvePromises.push(commitHold(sql, holdId).catch(e => { throw e; }));
        } else {
            resolvePromises.push(rollbackHold(sql, holdId).catch(e => { throw e; }));
        }
    }

    await Promise.all(resolvePromises);

    // 4. Verify Conservation of Value
    const [{ total }] = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(amount), 0)::text as total FROM konto_entries
    `;

    expect(BigInt(total)).toBe(TOTAL_SYSTEM_VALUE);
    
    // 5. Verify no orphaned holds remain
    const [{ count }] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM konto_holds
    `;
    expect(Number(count)).toBe(holdIdsToResolve.length);

  }, 120000); // 120s timeout

  it("committed hold no longer reduces available balance after settlement", async () => {
    const { alice, bob } = await createFundedAccounts(1000n);

    const { holdId } = await hold(sql, {
      accountId: alice,
      recipientId: bob,
      amount: 300n,
    });

    const pendingBalance = await getBalance(sql, alice);
    expect(pendingBalance.balance).toBe(700n);

    await commitHold(sql, holdId);

    const settledAlice = await getBalance(sql, alice);
    const settledBob = await getBalance(sql, bob);

    expect(settledAlice.balance).toBe(700n);
    expect(settledBob.balance).toBe(300n);
  });

  it("rolled-back hold no longer reduces available balance after release", async () => {
    const { alice, bob } = await createFundedAccounts(1000n);

    const { holdId } = await hold(sql, {
      accountId: alice,
      recipientId: bob,
      amount: 250n,
    });

    const pendingBalance = await getBalance(sql, alice);
    expect(pendingBalance.balance).toBe(750n);

    await rollbackHold(sql, holdId);

    const restoredAlice = await getBalance(sql, alice);
    const restoredBob = await getBalance(sql, bob);

    expect(restoredAlice.balance).toBe(1000n);
    expect(restoredBob.balance).toBe(0n);
  });

  it("NULL-expiry committed hold does not freeze funds indefinitely", async () => {
    const { alice, bob } = await createFundedAccounts(1000n);

    const { holdId } = await hold(sql, {
      accountId: alice,
      recipientId: bob,
      amount: 400n,
    });

    const [{ expiresAt }] = await sql<{ expiresAt: Date | null }[]>`
      SELECT expires_at AS "expiresAt"
      FROM konto_holds
      WHERE id = ${holdId}
    `;
    expect(expiresAt).toBeNull();

    await commitHold(sql, holdId);

    const settledAlice = await getBalance(sql, alice);
    const settledBob = await getBalance(sql, bob);

    expect(settledAlice.balance).toBe(600n);
    expect(settledBob.balance).toBe(400n);
  });

  it("NULL-expiry rolled-back hold does not freeze funds indefinitely", async () => {
    const { alice, bob } = await createFundedAccounts(1000n);

    const { holdId } = await hold(sql, {
      accountId: alice,
      recipientId: bob,
      amount: 400n,
    });

    const [{ expiresAt }] = await sql<{ expiresAt: Date | null }[]>`
      SELECT expires_at AS "expiresAt"
      FROM konto_holds
      WHERE id = ${holdId}
    `;
    expect(expiresAt).toBeNull();

    await rollbackHold(sql, holdId);

    const restoredAlice = await getBalance(sql, alice);
    const restoredBob = await getBalance(sql, bob);

    expect(restoredAlice.balance).toBe(1000n);
    expect(restoredBob.balance).toBe(0n);
  });
});
