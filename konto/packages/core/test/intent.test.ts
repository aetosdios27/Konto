import { readFile } from "node:fs/promises";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDatabase } from "./database";
import * as core from "../src/index";

describe("intent and caller-owned transactions", () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase();
    await database.sql.unsafe(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    await database.sql`CREATE TABLE app_events (journal_id UUID REFERENCES konto_journals(id), accepted BOOLEAN NOT NULL CHECK (accepted))`;
  }, 120000);
  afterAll(async () => { await database?.close(); });

  async function accounts() {
    const sql = database.sql;
    const bank = await core.createAccount(sql, { name: crypto.randomUUID(), currency: "INR", account_type: "EQUITY" });
    const alice = await core.createAccount(sql, { name: crypto.randomUUID(), currency: "INR" });
    const bob = await core.createAccount(sql, { name: crypto.randomUUID(), currency: "INR" });
    await core.transfer(sql, { accountId: bank.id, entries: [{ accountId: bank.id, amount: -1000n }, { accountId: alice.id, amount: 1000n }] });
    return { alice: alice.id, bob: bob.id };
  }

  for (const intentType of ["TRANSFER", "COMMIT_HOLD", "ROLLBACK_HOLD"] as const) {
    it(`executes ${intentType} and its status transition in one transaction`, async () => {
      const sql = database.sql;
      const { alice, bob } = await accounts();
      const { holdId } = await core.hold(sql, { accountId: alice, recipientId: bob, amount: 200n });
      const payload = intentType === "TRANSFER"
        ? { accountId: alice, idempotencyKey: crypto.randomUUID(), entries: [{ accountId: alice, amount: "-100" }, { accountId: bob, amount: "100" }] }
        : { holdId };
      const { intentId } = await core.stageIntent(sql, { intentType, payload });
      expect(await core.executeIntent(sql, intentId)).toMatchObject({ success: true });
      const [intent] = await sql`SELECT status, executed_at FROM konto_staged_intents WHERE id = ${intentId}`;
      expect(intent.status).toBe("EXECUTED");
      expect(intent.executed_at).toBeInstanceOf(Date);
      expect((await core.getBalance(sql, alice)).balance).toBe(intentType === "TRANSFER" ? 700n : intentType === "COMMIT_HOLD" ? 800n : 1000n);
      expect((await core.getBalance(sql, bob)).balance).toBe(intentType === "TRANSFER" ? 100n : intentType === "COMMIT_HOLD" ? 200n : 0n);
      await expect(core.executeIntent(sql, intentId)).rejects.toThrow(/only PENDING/);
    });
  }

  it("rolls ledger postings and hold status back when the intent status update fails", async () => {
    const sql = database.sql;
    const { alice, bob } = await accounts();
    const { holdId } = await core.hold(sql, { accountId: alice, recipientId: bob, amount: 300n });
    const { intentId } = await core.stageIntent(sql, { intentType: "COMMIT_HOLD", payload: { holdId } });
    await sql.unsafe(`
      CREATE FUNCTION fail_intent_execution() RETURNS trigger AS $$ BEGIN
        RAISE EXCEPTION 'intent status write rejected';
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_execution BEFORE UPDATE ON konto_staged_intents
        FOR EACH ROW EXECUTE FUNCTION fail_intent_execution();
    `);
    try {
      await expect(core.executeIntent(sql, intentId)).rejects.toThrow("intent status write rejected");
    } finally {
      await sql`DROP TRIGGER fail_execution ON konto_staged_intents`;
    }
    const [intent] = await sql`SELECT status FROM konto_staged_intents WHERE id = ${intentId}`;
    const [held] = await sql`SELECT status FROM konto_holds WHERE id = ${holdId}`;
    expect(intent.status).toBe("PENDING");
    expect(held.status).toBe("PENDING");
    expect((await core.getBalance(sql, alice)).balance).toBe(700n);
    expect((await core.getBalance(sql, bob)).balance).toBe(0n);
  });

  it("commits a transfer and an application event on the caller's transaction handle", async () => {
    const sql = database.sql;
    const { alice, bob } = await accounts();
    const journalId = await sql.begin(async (tx) => {
      const { journalId } = await core.transferInTx(tx, { accountId: alice, entries: [{ accountId: alice, amount: -100n }, { accountId: bob, amount: 100n }] });
      await tx`INSERT INTO app_events (journal_id, accepted) VALUES (${journalId}, true)`;
      return journalId;
    });
    const events = await sql`SELECT journal_id FROM app_events WHERE journal_id = ${journalId}`;
    expect(events).toHaveLength(1);
    expect((await core.getBalance(sql, bob)).balance).toBe(100n);
  });

  it("rolls back a transfer if its application event cannot be written", async () => {
    const sql = database.sql;
    const { alice, bob } = await accounts();
    await expect(sql.begin(async (tx) => {
      const { journalId } = await core.transferInTx(tx, { accountId: alice, entries: [{ accountId: alice, amount: -100n }, { accountId: bob, amount: 100n }] });
      await tx`INSERT INTO app_events (journal_id, accepted) VALUES (${journalId}, false)`;
    })).rejects.toThrow(/check constraint/);
    expect((await core.getBalance(sql, alice)).balance).toBe(1000n);
    expect((await core.getBalance(sql, bob)).balance).toBe(0n);
  });

  it("rolls back hold settlement and release when the caller aborts", async () => {
    const sql = database.sql;
    const { alice, bob } = await accounts();
    const { holdId } = await core.hold(sql, { accountId: alice, recipientId: bob, amount: 200n });
    await expect(sql.begin(async (tx) => {
      const { journalId } = await core.commitHoldInTx(tx, holdId);
      await tx`INSERT INTO app_events (journal_id, accepted) VALUES (${journalId}, false)`;
    })).rejects.toThrow(/check constraint/);
    await expect(sql.begin(async (tx) => {
      await core.rollbackHoldInTx(tx, holdId);
      throw new Error("event failed");
    })).rejects.toThrow("event failed");
    const [held] = await sql`SELECT status FROM konto_holds WHERE id = ${holdId}`;
    expect(held.status).toBe("PENDING");
    expect((await core.getBalance(sql, alice)).balance).toBe(800n);
    expect((await core.getBalance(sql, bob)).balance).toBe(0n);
  });
});
