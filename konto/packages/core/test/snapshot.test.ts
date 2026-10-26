import { readFile } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase } from "./database";
import { migrate } from "../../cli/src/commands/migrate";
import { createAccount } from "../src/account";
import { transfer } from "../src/transfer";
import { hold, commitHold, rollbackHold } from "../src/hold";
import { getBalance } from "../src/read";

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.each(["schema", "migrations"])("snapshot correctness (%s)", (source) => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    if (source === "schema") {
      await database.sql.unsafe(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    } else {
      await migrate(database.sql, { migrationsPath: new URL("../../cli/migrations", import.meta.url).pathname });
    }
  }, 120000);

  afterAll(async () => { await database?.close(); });

  async function accounts() {
    const sql = database.sql;
    const bank = await createAccount(sql, { name: crypto.randomUUID(), currency: "INR", account_type: "EQUITY" });
    const alice = await createAccount(sql, { name: crypto.randomUUID(), currency: "INR" });
    const bob = await createAccount(sql, { name: crypto.randomUUID(), currency: "INR" });
    await transfer(sql, { accountId: bank.id, entries: [{ accountId: bank.id, amount: -1000n }, { accountId: alice.id, amount: 1000n }] });
    return { alice: alice.id, bob: bob.id };
  }

  it("stores posted balances only, including repeated snapshots and hold release", async () => {
    const sql = database.sql;
    const { alice, bob } = await accounts();
    const { holdId } = await hold(sql, { accountId: alice, recipientId: bob, amount: 250n });
    for (let i = 0; i < 3; i++) {
      await sql`SELECT take_snapshot(${alice})`;
      expect((await getBalance(sql, alice)).balance).toBe(750n);
    }
    const snapshots = await sql`SELECT balance::text FROM konto_balance_snapshots WHERE account_id = ${alice}`;
    expect(snapshots.map((row) => row.balance)).toEqual(["1000", "1000", "1000"]);
    await rollbackHold(sql, holdId);
    expect((await getBalance(sql, alice)).balance).toBe(1000n);
  });

  it("settles a hold after a snapshot without subtracting its reservation twice", async () => {
    const sql = database.sql;
    const { alice, bob } = await accounts();
    const { holdId } = await hold(sql, { accountId: alice, recipientId: bob, amount: 700n });
    await sql`SELECT take_snapshot(${alice})`;
    await commitHold(sql, holdId);
    expect((await getBalance(sql, alice)).balance).toBe(300n);
    expect((await getBalance(sql, bob)).balance).toBe(700n);
  });

  it("includes entries posted after a snapshot in the same transaction timestamp", async () => {
    const sql = database.sql;
    const { alice, bob } = await accounts();
    await sql.begin(async (tx) => {
      await tx`SELECT take_snapshot(${alice})`;
      const [journal] = await tx`INSERT INTO konto_journals (account_id) VALUES (${alice}) RETURNING id`;
      await tx`INSERT INTO konto_entries (journal_id, account_id, amount) VALUES (${journal.id}, ${alice}, -200), (${journal.id}, ${bob}, 200)`;
      expect((await getBalance(tx, alice)).balance).toBe(800n);
    });
    expect((await getBalance(sql, alice)).balance).toBe(800n);
  });

  it("includes backdated postings after the cutoff and records an exact sequence prefix", async () => {
    const sql = database.sql;
    const { alice, bob } = await accounts();
    await sql`SELECT take_snapshot(${alice})`;
    await sql.begin(async (tx) => {
      const [journal] = await tx`INSERT INTO konto_journals (account_id) VALUES (${alice}) RETURNING id`;
      await tx`INSERT INTO konto_entries (journal_id, account_id, amount, created_at) VALUES (${journal.id}, ${alice}, -200, '2000-01-01'), (${journal.id}, ${bob}, 200, '2000-01-01')`;
    });
    expect((await getBalance(sql, alice)).balance).toBe(800n);
    await sql`SELECT take_snapshot(${alice})`;
    const rows = await sql`
      SELECT s.balance::text, COALESCE(SUM(e.amount), 0)::text AS expected
      FROM konto_balance_snapshots s LEFT JOIN konto_entries e
        ON e.account_id = s.account_id AND e.entry_sequence <= s.entry_sequence
      WHERE s.account_id = ${alice} GROUP BY s.id
    `;
    expect(rows.every((row) => row.balance === row.expected)).toBe(true);
  });

  it("locks the account so direct postings wait until the snapshot transaction commits", async () => {
    const sql = database.sql;
    const { alice, bob } = await accounts();
    const ready = signal();
    const finish = signal();
    const snapshot = sql.begin(async (tx) => {
      await tx`SELECT take_snapshot(${alice})`;
      ready.resolve();
      await finish.promise;
    });
    await ready.promise;
    const posting = sql.begin(async (tx) => {
      await tx`SET LOCAL application_name = 'konto_snapshot_posting'`;
      const [journal] = await tx`INSERT INTO konto_journals (account_id) VALUES (${alice}) RETURNING id`;
      await tx`INSERT INTO konto_entries (journal_id, account_id, amount) VALUES (${journal.id}, ${alice}, -100), (${journal.id}, ${bob}, 100)`;
    });
    try {
      await expect.poll(async () => {
        const [row] = await sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'konto_snapshot_posting' AND wait_event_type = 'Lock') AS blocked`;
        return row.blocked;
      }, { timeout: 2000, interval: 10 }).toBe(true);
    } finally {
      finish.resolve();
      await Promise.all([snapshot, posting]);
    }
    expect((await getBalance(sql, alice)).balance).toBe(900n);
  });
});
