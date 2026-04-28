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
import { hold } from "../src/hold";
import { getAccount, getBalance, getJournals } from "../src/read";
import { KontoAccountNotFoundError } from "../src/errors";

describe("Konto Read API", () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;

  let accountA: string;
  let accountB: string;
  let accountC: string;
  let accountBank: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    sql = postgres(container.getConnectionUri(), { max: 5 });

    const schemaPath = path.resolve(__dirname, "../schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf-8");
    await sql.unsafe(schemaSql);

    // Initial setup
    accountA = uuidv4();
    accountB = uuidv4();
    accountC = uuidv4();
    accountBank = uuidv4();

    await sql`
      INSERT INTO konto_accounts (id, name, currency)
      VALUES 
        (${accountA}, 'Alice', 'INR'), 
        (${accountB}, 'Bob', 'INR'), 
        (${accountC}, 'Charlie', 'INR'),
        (${accountBank}, 'Bank', 'INR')
    `;

    const [j] = await sql`INSERT INTO konto_journals (account_id, description) VALUES (${accountA}, 'genesis') RETURNING id`;

    // Fund A with 10_000, Fund B with 5_000
    await sql`
      INSERT INTO konto_entries (journal_id, account_id, amount)
      VALUES 
        (${j.id}, ${accountA}, ${10000n.toString()}),
        (${j.id}, ${accountB}, ${5000n.toString()}),
        (${j.id}, ${accountBank}, ${(-15000n).toString()})
    `;

    // Perform 5 transfers
    // A -> B: 100
    // A -> C: 200
    // B -> A: 50
    // C -> B: 10
    // B -> C: 300
    await transfer(sql, { accountId: accountA, entries: [{ accountId: accountA, amount: -100n }, { accountId: accountB, amount: 100n }] });
    await new Promise(r => setTimeout(r, 10)); // Sleep strictly for sorting logic explicitly defining tie-breakers natively
    await transfer(sql, { accountId: accountA, entries: [{ accountId: accountA, amount: -200n }, { accountId: accountC, amount: 200n }] });
    await new Promise(r => setTimeout(r, 10));
    await transfer(sql, { accountId: accountB, entries: [{ accountId: accountB, amount: -50n }, { accountId: accountA, amount: 50n }] });
    await new Promise(r => setTimeout(r, 10));
    await transfer(sql, { accountId: accountC, entries: [{ accountId: accountC, amount: -10n }, { accountId: accountB, amount: 10n }] });
    await new Promise(r => setTimeout(r, 10));
    await transfer(sql, { accountId: accountB, entries: [{ accountId: accountB, amount: -300n }, { accountId: accountC, amount: 300n }] });

    // Hold 500 from Alice for Charlie
    await hold(sql, { accountId: accountA, recipientId: accountC, amount: 500n, metadata: {} });

  }, 120000);

  afterAll(async () => {
    if (sql) await sql.end();
    if (container) await container.stop();
  });

  describe("getAccount()", () => {
    it("should fetch account metadata correctly", async () => {
      const account = await getAccount(sql, accountA);
      expect(account).not.toBeNull();
      expect(account?.id).toBe(accountA);
      expect(account?.name).toBe("Alice");
      expect(account?.currency).toBe("INR");
    });

    it("should return null for non-existent accounts", async () => {
      const account = await getAccount(sql, uuidv4());
      expect(account).toBeNull();
    });
  });

  describe("getBalance()", () => {
    it("should fetch the accurate liquid balance considering entries AND active holds", async () => {
      // Alice: Starts 10000. -100, -200, +50 = 9750 (entries). Hold: 500. Total Liquid = 9250.
      const aliceBal = await getBalance(sql, accountA);
      expect(aliceBal.balance).toBe(9250n);

      // Bob: Starts 5000. +100, -50, +10, -300 = 4760. Hold: 0. Total = 4760.
      const bobBal = await getBalance(sql, accountB);
      expect(bobBal.balance).toBe(4760n);

      // Charlie: Starts 0. +200, -10, +300 = 490. Hold: 0. Total = 490.
      const charlieBal = await getBalance(sql, accountC);
      expect(charlieBal.balance).toBe(490n);
    });

    it("should throw KontoAccountNotFoundError if account doesn't exist", async () => {
      await expect(getBalance(sql, uuidv4())).rejects.toThrow(KontoAccountNotFoundError);
    });
  });

  describe("getJournals()", () => {
    it("should fetch paginated journal history effectively parsing BigInt without floating point decay", async () => {
      // Alice is involved in Genesis + 3 transfers = 4 journals total.
      const aliceJ = await getJournals(sql, accountA, { limit: 10 });
      expect(aliceJ.length).toBe(4);

      // Check sorting: Genesis should be the last one physically speaking
      const genesis = aliceJ[aliceJ.length - 1];
      expect(genesis.description).toBe("genesis");

      // Verify entries deserialized to true BigInt exactly averting Max Safe Integer bounds!
      expect(typeof genesis.entries[0].amount).toBe("bigint");
    });

    it("should correctly handle deterministic keyset pagination (cursorId & cursorDate)", async () => {
      const aliceJ = await getJournals(sql, accountA, { limit: 2 });
      expect(aliceJ.length).toBe(2);

      const cursorJ = aliceJ[1];
      const nextBatch = await getJournals(sql, accountA, { limit: 2, cursorId: cursorJ.id, cursorDate: cursorJ.createdAt });
      expect(nextBatch.length).toBe(2);

      expect(nextBatch[0].id).not.toBe(cursorJ.id);
      expect(nextBatch[0].id).not.toBe(aliceJ[0].id);
    });
  });
});
